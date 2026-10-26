# Suri Admin — Link Manager Frontend

A modern, fast, zero-dependency client-side dashboard to manage your [Suri](https://github.com/surishortlink/suri) short links hosted with [`suri-deploy-github`](https://github.com/surishortlink/suri-deploy-github).

It communicates directly with GitHub's REST API from your browser to read and update `src/links.json`. Whenever you deploy changes from Suri Admin, GitHub Actions automatically rebuilds your static redirect pages and updates your GitHub Pages site.

---

## ✨ Features

- **Direct GitHub Integration**: Connects via GitHub Personal Access Token (PAT) with `repo` permissions.
- **Auto-Login & Session Persistence**: Remembers your repository credentials in `localStorage` and automatically reconnects on return.
- **Full Inline Editing**: Edit both the short path (`slug`) and destination `URL` inline with keyboard shortcuts (`Enter` to save, `Esc` to cancel).
- **Bulk Operations**:
  - Checkbox selection & "Select All"
  - Bulk delete selected links
  - Bulk export selected links as JSON
- **Import & Export**:
  - Export all links as formatted `links.json` or `links.csv`
  - Import from `.json` or `.csv` with choice to **Merge** or **Replace All**
- **Stats & Change Tracking**: Real-time counters for Total, New, Modified, and Deleted links before committing.
- **Deploy Workflow**:
  - Custom commit messages
  - One-click deploy that pushes directly to GitHub via API
  - Direct link to GitHub Actions workflow run to monitor build progress
- **Short Link Helper & QR Codes**:
  - One-click copy for the full short URL (e.g. `https://yourname.github.io/slug`)
  - QR Code viewer modal for easy sharing
- **Safety**: Custom modal confirmation dialogs for destructive actions.
- **Keyboard Shortcuts**:
  - <kbd>Ctrl</kbd> + <kbd>S</kbd> / <kbd>Cmd</kbd> + <kbd>S</kbd>: Open Deploy modal
  - <kbd>/</kbd>: Jump to search box
  - <kbd>Esc</kbd>: Cancel editing or close active modal
  - <kbd>Enter</kbd>: Save editing row or submit forms

---

## 🚀 How to Add to Your Existing Suri Repository

In Suri's architecture, anything placed inside the **`public/`** folder is automatically copied into the final build directory by GitHub Actions during deployment.

### Steps to add `suri-admin`:

1. In your existing Suri repository, create a directory:
   ```bash
   public/suri-admin/
   ```
2. Copy the contents of this folder (`index.html`, `style.css`, `app.js`) into `public/suri-admin/`:
   ```bash
   # From your existing Suri repo root:
   mkdir -p public/suri-admin
   cp -r "/Users/tchels/Documents/Anti Gravity/suri-admin/"* public/suri-admin/
   ```
3. Commit and push:
   ```bash
   git add public/suri-admin
   git commit -m "Add Suri Admin dashboard to public/suri-admin"
   git push
   ```
4. GitHub Actions will trigger automatically, build your links, and deploy.
5. Your dashboard is now live at:
   ```
   https://<your-domain-or-github.io>/suri-admin/
   ```
   *(e.g. `https://tchelsic.github.io/suri-admin/` or `https://tchelsic.github.io/<repo>/suri-admin/`)*

---

## 🔑 GitHub Personal Access Token (PAT) Setup

To allow Suri Admin to read and write your `src/links.json` file:

1. Go to [GitHub Token Settings](https://github.com/settings/tokens/new?scopes=repo&description=Suri+Admin).
2. Set Note: `Suri Admin`.
3. Check the **`repo`** scope (Full control of private and public repositories).
4. Click **Generate token**.
5. Copy the token (`ghp_...`) and paste it into Suri Admin along with:
   - **Repository**: `username/repo` (e.g. `tchelsic/tchelsic.github.io`)
   - **Branch**: `main`
   - **Path to links.json**: `src/links.json` (default for `suri-deploy-github`)
6. Check **"Remember token in this browser"** for seamless auto-login next time.

---

## 📂 File Structure

```
suri-admin/
├── index.html   # Main layout, modals, toolbar, and stats dashboard
├── style.css    # Clean dark theme with responsive styling & animations
├── app.js       # GitHub API integration, table logic, import/export, and shortcuts
└── README.md    # Documentation and usage guide
```
