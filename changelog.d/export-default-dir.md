---
category: Added
---

- **Workflow exports now always save to disk** — omitting `outputPath` saves the signed bundle to the default export directory (`<home>/Downloads/Rewst Exports`, created when missing) instead of only returning it inline. Set `rewst-buddy.mcp.exportDefaultDir` to an absolute path to override it cross-OS; the configured directory is created on demand and automatically approved.
