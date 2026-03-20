#!/bin/bash

# ============================================================
# Orelay Rename Script
# Renames orelay → orelay across all files & folders
# Run from INSIDE your orelay directory
# ============================================================

set -e

echo "🚀 Starting Orelay rename..."
echo ""

# ---- Safety check ----
if [ ! -f "package.json" ]; then
  echo "❌ ERROR: Run this script from inside your orelay directory."
  echo "   cd /Users/russoanastasio/Code/orelay"
  echo "   bash rename-to-orelay.sh"
  exit 1
fi

echo "✅ Found package.json — looks like the right directory."
echo ""

# ---- Text replacements inside files ----
# Uses sed to replace all variations of the old name with the new one.
# Order matters: longer/more-specific strings first.

echo "📝 Replacing text in source files..."

# Function to do sed replacement across all relevant files
replace_in_files() {
  local OLD="$1"
  local NEW="$2"
  echo "   '$OLD' → '$NEW'"
  grep -rl "$OLD" --include="*.js" --include="*.json" --include="*.md" \
       --include="*.html" --include="*.sh" --include="*.txt" \
       --include="*.yml" --include="*.yaml" . 2>/dev/null \
  | xargs sed -i '' "s|$OLD|$NEW|g" 2>/dev/null || true
}

# Display name variations
replace_in_files "Orelay"        "Orelay"
replace_in_files "P2P Transfer"            "Orelay"
replace_in_files "orelay"        "orelay"
replace_in_files "orelay"            "orelay"
replace_in_files "orelay"        "orelay"
replace_in_files "orelay"          "orelay"
replace_in_files "orelay"             "orelay"
replace_in_files "Orelay"        "Orelay"

# App ID / bundle identifier
replace_in_files "com.orbitolive.orelay"     "com.orbitolive.orelay"

# File type associations (keep .ort extension or change to .ort — your choice)
# Keeping .ort for now since tokens are already distributed; 
# Uncomment the next line to switch to .ort instead:
# replace_in_files ".ort"               ".ort"

# Product / window titles
replace_in_files "productName": "Orelay" 'productName": "Orelay'

echo ""
echo "✅ Text replacements complete."
echo ""

# ---- Rename the server package ----
echo "📦 Updating server/package.json name field..."
if [ -f "server/package.json" ]; then
  sed -i '' 's/"name": "orelay-signaling-server"/"name": "orelay-signaling-server"/' server/package.json
  echo "   ✅ server/package.json updated"
fi

# ---- Rename the parent folder ----
echo ""
echo "📁 Renaming project folder..."
CURRENT_DIR="$(pwd)"
PARENT_DIR="$(dirname "$CURRENT_DIR")"
NEW_DIR="$PARENT_DIR/orelay"

if [ -d "$NEW_DIR" ]; then
  echo "   ⚠️  '$NEW_DIR' already exists — skipping folder rename."
  echo "      You can manually rename or delete the existing folder."
else
  mv "$CURRENT_DIR" "$NEW_DIR"
  echo "   ✅ Renamed: orelay → orelay"
  echo ""
  echo "   ⚠️  Your terminal is now pointing to the OLD path."
  echo "   Run this to get back into the project:"
  echo ""
  echo "      cd $NEW_DIR"
fi

echo ""
echo "============================================================"
echo "✅  ALL DONE! Your app is now Orelay."
echo "============================================================"
echo ""
echo "Next steps:"
echo "  1. cd $NEW_DIR"
echo "  2. Open the project in VS Code:  code ."
echo "  3. Double-check branding in:"
echo "       - package.json  (name, productName, appId, author)"
echo "       - src/main.js   (window title, about panel)"
echo "       - README.md / PROJECT_OVERVIEW.md / QUICKSTART.md"
echo "  4. Reinstall dependencies (optional, safe to skip):"
echo "       npm install && cd server && npm install && cd .."
echo "  5. Run the app:  npm start"
echo ""
