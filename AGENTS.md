# Krugi prototype

Independent local project. Do not change Resulvo. All downloads, environments and caches stay inside this root. No global settings or autostart. Services bind 127.0.0.1; ports 9150/3150/8150. Use scripts/setup.ps1, scripts/start.ps1 and scripts/stop.ps1. Only stop verified owned processes. Browser checks use Codex in-app browser. Required check: bun run verify. Preserve concurrent edits; workers own assigned folders. Data JSON is immutable during runtime.
