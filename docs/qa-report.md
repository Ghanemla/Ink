# Ink 0.2.12 QA Report

0.2.12 fixes Arabic Dialect Speech Pack readiness detection after a successful Windows installation.

| Check | Result | Detail |
|---|---|---|
| App version | PASS | 0.2.12 |
| Main-process JavaScript syntax | PASS | `node --check electron/main.mjs` |
| Arabic service JavaScript syntax | PASS | `node --check electron/core/arabic-asr-service.mjs` |
| Arabic worker Python syntax | PASS | `python -m py_compile scripts/arabic-asr-worker.py` |
| Existing BOM marker parsing | PASS | Arabic service and main-process fallback strip leading U+FEFF before `JSON.parse` |
| New marker encoding | PASS | PowerShell writes UTF-8 using `UTF8Encoding(false)` |
| Shared runtime fallback | PASS | Translation private Python is reused if an old marker cannot be parsed |
| Model redownload required | NO | Existing model files and marker are reused |

The model itself is unchanged from 0.2.11. This patch only corrects installed-pack detection/state.
