import json
import urllib.request
import urllib.error

url = 'http://127.0.0.1:5000/paraphrase'
data = json.dumps({"text": "Das ist ein kurzer Testtext."}).encode('utf-8')
req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})

try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read().decode('utf-8')
        print('STATUS', resp.status)
        print('HEADERS', resp.getheaders())
        print('BODY', body)
except urllib.error.HTTPError as e:
    print('HTTP ERROR', e.code, e.read().decode('utf-8'))
except Exception as e:
    print('EXCEPTION', repr(e))
