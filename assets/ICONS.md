# Application Icons

For production deployment, you'll need to create icon files for each platform:

## Required Icon Files

### macOS
- `assets/icon.icns` - macOS application icon
  - Create from a 1024x1024 PNG using tools like:
    - [iconutil](https://developer.apple.com/library/archive/documentation/GraphicsAnimation/Conceptual/HighResolutionOSX/Optimizing/Optimizing.html) (macOS built-in)
    - [png2icns](https://github.com/bitboss-ca/png2icns)
    - Online tool: [cloudconvert.com](https://cloudconvert.com/png-to-icns)

### Windows
- `assets/icon.ico` - Windows application icon
  - Create from 256x256 PNG using:
    - [ImageMagick](https://imagemagick.org/): `convert icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico`
    - Online tool: [icoconvert.com](https://icoconvert.com/)

### Linux
- `assets/icon.png` - Linux application icon (512x512 or 1024x1024)

## Temporary Solution

Until you create custom icons, electron-builder will use default icons. The app will work fine, just without custom branding.

## Design Tips

For a file transfer app, consider icons featuring:
- Arrows (↔️ transfer concept)
- Connected nodes (⚡ P2P concept)
- Document/folder shapes (📁 files)
- Modern, minimalist design

## Example Icon Creation Workflow

1. Create a 1024x1024 PNG design (icon.png)
2. Convert to .icns for macOS:
   ```bash
   # On macOS
   mkdir icon.iconset
   sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
   sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
   sips -z 32 32     icon.png --out icon.iconset/icon_32x32.png
   sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png
   sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
   sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
   sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png
   sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
   sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png
   sips -z 1024 1024 icon.png --out icon.iconset/icon_512x512@2x.png
   iconutil -c icns icon.iconset
   ```

3. Convert to .ico for Windows:
   ```bash
   convert icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
   ```

4. Copy icon.png for Linux (512x512 recommended)

## Where to Place Icons

```
orelay/
├── assets/
│   ├── icon.icns    (macOS)
│   ├── icon.ico     (Windows)
│   └── icon.png     (Linux)
```

The build configuration in `package.json` already references these paths.
