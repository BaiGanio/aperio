#!/bin/bash

# 1. Get the directory where this script is stored
# (Crucial for Mac/Linux double-clicking)
PARENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PARENT_DIR"

# 2. Ensure the main script is executable
chmod +x ./start.sh

# 3. Launch the main logic
./start.sh



🚀 Quick Start
Windows: Double-click run_windows.bat
Mac/Linux: Open a terminal in this folder and run bash run_unix.sh (or Right-click run_unix.sh > Open)