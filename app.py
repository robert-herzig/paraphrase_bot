import os
from flask import Flask, render_template, request, jsonify, Response
from openai import OpenAI
from dotenv import load_dotenv
import concurrent.futures
import json
import httpx

# Load environment variables
load_dotenv()

app = Flask(__name__)

# Configuration for OpenWebUI / OpenAI compatible API
API_BASE_URL = os.getenv("OPENWEBUI_API_BASE", "http://localhost:3000/api/v1") # Default to common OpenWebUI port
API_KEY = os.getenv("OPENWEBUI_API_KEY", "sk-no-key-required") # OpenWebUI often doesn't need a real key for local use
MODEL_NAME = os.getenv("OPENWEBUI_MODEL", "gpt-3.5-turbo") # Replace with your model name in OpenWebUI
# Default timeout (seconds) for model requests and streaming. Increase if your model needs more time.
MODEL_TIMEOUT = float(os.getenv("MODEL_TIMEOUT", "60"))

client = OpenAI(
    base_url=API_BASE_URL,
    api_key=API_KEY,
)

def get_system_prompt():
    try:
        with open("system_prompt.txt", "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return "Du bist ein hilfreicher Assistent, der Texte in Leichte Sprache übersetzt."

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/paraphrase', methods=['POST'])
def paraphrase():
    data = request.json
    user_text = data.get('text')

    if not user_text:
        return jsonify({"error": "Kein Text bereitgestellt"}), 400

    system_prompt = get_system_prompt()

    def call_api():
        # Make the API call using httpx so we can enforce a network timeout.
        # Make the user message explicit to avoid the model asking for the text.
        user_message = "Übersetze den folgenden Text in Leichte Sprache:\n\n" + user_text
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message}
        ]
        # Debug: print outgoing messages
        print("Calling model with messages:", messages)

        url = API_BASE_URL.rstrip('/') + '/chat/completions'
        headers = {
            'Authorization': f'Bearer {API_KEY}',
            'Content-Type': 'application/json'
        }
        payload = {
            'model': MODEL_NAME,
            'messages': messages
        }

        try:
            with httpx.Client(timeout=MODEL_TIMEOUT) as client_http:
                r = client_http.post(url, headers=headers, json=payload)
                # Debug: print status and raw text
                print(f"API HTTP status: {r.status_code}")
                print("Model response raw text:", r.text)
                r.raise_for_status()
                return r.json()
        except httpx.RequestError as e:
            print(f"HTTP request error: {e}")
            raise
        except httpx.HTTPStatusError as e:
            print(f"HTTP status error: {e.response.status_code} - {e.response.text}")
            raise

    # Run the API call in a separate thread with a timeout to avoid UI hangs.
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(call_api)
        try:
            # Allow a bit more than the HTTP client timeout for scheduling
            response = future.result(timeout=MODEL_TIMEOUT + 5)
        except concurrent.futures.TimeoutError:
            future.cancel()
            msg = "Die Anfrage an das Sprachmodell hat zu lange gedauert. Bitte später erneut versuchen."
            print("API call timeout")
            return jsonify({"error": msg}), 504
        except Exception as e:
            # Return structured error message if available
            print(f"Error calling API: {e}")
            # Detect read timeout specifically and return 504
            try:
                from httpx import ReadTimeout
                if isinstance(e, ReadTimeout):
                    return jsonify({"error": "Die Anfrage an das Sprachmodell hat zu lange gedauert (Timeout)."}), 504
            except Exception:
                pass
            if 'ReadTimeout' in repr(e):
                return jsonify({"error": "Die Anfrage an das Sprachmodell hat zu lange gedauert (Timeout)."}), 504
            return jsonify({"error": str(e)}), 500

    # Extract text from response robustly
    paraphrased_text = None
    try:
        if isinstance(response, dict):
            # Common shape for OpenAI chat/completions
            try:
                paraphrased_text = response['choices'][0]['message']['content']
            except Exception:
                try:
                    paraphrased_text = response['choices'][0]['text']
                except Exception:
                    paraphrased_text = json.dumps(response, ensure_ascii=False)
        else:
            paraphrased_text = str(response)
    except Exception as e:
        print(f"Error extracting response text: {e}")
        paraphrased_text = str(response)

    return jsonify({"result": paraphrased_text})


@app.route('/paraphrase_stream', methods=['POST'])
def paraphrase_stream():
    """Streamed paraphrase using the underlying API streaming endpoint.

    This endpoint returns a stream in SSE-like format where each event is
    prefixed with `data: ` and separated by a blank line. The frontend reads
    these chunks and appends them to the visible output.
    """
    data = request.json
    user_text = data.get('text')

    if not user_text:
        return jsonify({"error": "Kein Text bereitgestellt"}), 400

    system_prompt = get_system_prompt()
    user_message = "Übersetze den folgenden Text in Leichte Sprache:\n\n" + user_text
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_message}
    ]

    url = API_BASE_URL.rstrip('/') + '/chat/completions'
    headers = {
        'Authorization': f'Bearer {API_KEY}',
        'Content-Type': 'application/json'
    }
    payload = {
        'model': MODEL_NAME,
        'messages': messages,
        'stream': True
    }

    def event_stream():
        try:
            with httpx.Client(timeout=MODEL_TIMEOUT) as client_http:
                with client_http.stream('POST', url, headers=headers, json=payload) as r:
                    for raw_line in r.iter_lines():
                        if not raw_line:
                            continue
                        line = raw_line.decode('utf-8') if isinstance(raw_line, bytes) else raw_line
                        # OpenAI-style streaming lines start with "data: "
                        if line.startswith('data: '):
                            data_part = line[len('data: '):].strip()
                            if data_part == '[DONE]':
                                # Close the stream
                                yield 'data: [DONE]\n\n'
                                break
                            try:
                                j = json.loads(data_part)
                                # extract delta content
                                delta = ''
                                for choice in j.get('choices', []):
                                    d = choice.get('delta', {})
                                    if 'content' in d:
                                        delta += d['content']
                                if delta:
                                    # send as an SSE data chunk
                                    # we escape nothing; frontend expects raw text after 'data: '
                                    yield f'data: {delta}\n\n'
                            except Exception as e:
                                print('Failed to parse stream chunk:', e, line)
                                # forward raw chunk so frontend can at least show something
                                yield f'data: {data_part}\n\n'
        except Exception as e:
            print('Streaming request error:', e)
            yield f'data: ERROR: {e}\n\n'

    return Response(event_stream(), mimetype='text/event-stream')

# --- System prompt management endpoints ---
@app.route('/system_prompt', methods=['GET'])
def api_get_system_prompt():
    """Return current system prompt text."""
    try:
        with open("system_prompt.txt", "r", encoding="utf-8") as f:
            return jsonify({"prompt": f.read()})
    except Exception as e:
        return jsonify({"error": f"Fehler beim Lesen des System-Prompts: {e}"}), 500

@app.route('/system_prompt', methods=['POST'])
def api_update_system_prompt():
    """Update system prompt text from request body {prompt: "..."}."""
    data = request.get_json(force=True) or {}
    new_prompt = (data.get('prompt') or '').strip()
    if not new_prompt:
        return jsonify({"error": "Kein Prompt übermittelt."}), 400
    if len(new_prompt) > 20000:
        return jsonify({"error": "Prompt ist zu lang (Max 20.000 Zeichen)."}), 400
    try:
        with open("system_prompt.txt", "w", encoding="utf-8") as f:
            f.write(new_prompt)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": f"Fehler beim Speichern des System-Prompts: {e}"}), 500

if __name__ == '__main__':
    app.run(debug=True, port=5000)
