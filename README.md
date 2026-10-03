# Roster Ops + NOC: code-only copy for the Windows test

This private repository holds only the program, its tests and the launchers, so
GitHub Actions can run them on real Windows (`.github/workflows/windows.yml`).
The team's Data Roster.xlsx and rosters are not here. It is rebuilt from the main
project with `node automation/v2/tools/ci-mirror.mjs`.
