import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import logoImg from "./assets/logo.png";
import "./App.css";

// ================== Types ==================
interface FileInfo {
  name: string;
  path: string;
  size: number;
  extension: string;
  created_at: number;
  modified_at: number;
}

interface DuplicateGroup {
  hash: string;
  size: number;
  files: FileInfo[];
}

interface ProgressPayload {
  scanned_count: number;
  current_path: string;
}

type FilterType = "all" | "images" | "archives" | "documents" | "duplicates" | "custom" | "empty_folders";

// ================== Helper ==================
function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString();
}

// ================== Sidebar Item ==================
const categories: { label: string; value: FilterType; icon: string }[] = [
  { label: "All Files", value: "all", icon: "🗂️" },
  { label: "Images", value: "images", icon: "🖼️" },
  { label: "Archives", value: "archives", icon: "📦" },
  { label: "Documents", value: "documents", icon: "📄" },
  { label: "Duplicates", value: "duplicates", icon: "👯" },
  { label: "Empty Folders", value: "empty_folders", icon: "📂" },
  { label: "Custom", value: "custom", icon: "⚙️" },
];

// ================== App ==================
function App() {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [scanPath, setScanPath] = useState("/home/billa");
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [emptyFolders, setEmptyFolders] = useState<string[]>([]);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<ProgressPayload | null>(null);
  const [customExts, setCustomExts] = useState("");

  useEffect(() => {
    let unlisten: () => void;
    async function setupListener() {
      unlisten = await listen<ProgressPayload>("scan_progress", (event) => {
        setScanProgress(event.payload);
      });
    }
    setupListener();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);
  
  // Advanced filters
  const [minSizeMB, setMinSizeMB] = useState("");
  const [maxSizeMB, setMaxSizeMB] = useState("");

  async function startScan(type: FilterType = filterType) {
    if (!scanPath.trim()) return;
    setLoading(true);
    setError(null);
    setFiles([]);
    setDuplicateGroups([]);
    setScanProgress(null);
    try {
      if (type === "duplicates") {
        const result: DuplicateGroup[] = await invoke("find_duplicates", {
          path: scanPath.trim(),
        });
        setDuplicateGroups(result);
        setScanned(true);
      } else if (type === "empty_folders") {
        const result: string[] = await invoke("find_empty_folders", {
          path: scanPath.trim(),
        });
        setEmptyFolders(result);
        setScanned(true);
      } else {
        const min = minSizeMB ? parseFloat(minSizeMB) * 1024 * 1024 : null;
        const max = maxSizeMB ? parseFloat(maxSizeMB) * 1024 * 1024 : null;
        
        const effectiveType = type === "custom" ? `custom:${customExts}` : type;
        
        const result: FileInfo[] = await invoke("scan_files", {
          path: scanPath.trim(),
          filterType: effectiveType,
          minSize: min && !isNaN(min) ? min : null,
          maxSize: max && !isNaN(max) ? max : null,
        });
        setFiles(result);
        setScanned(true);
      }
    } catch (err) {
      console.error("Scan Error:", err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleBrowse() {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: scanPath,
      });
      if (selected && typeof selected === "string") {
        setScanPath(selected);
        // Automatically start scan after browsing
        // To be safe we set the path state and can call scan if we want, but let's just set the path for now
      }
    } catch (err) {
      console.error("Browse Error:", err);
      setError(String(err));
    }
  }

  async function handlePreview(path: string) {
    try {
      const base64 = await invoke<string>("get_image_base64", { path });
      setPreviewImage(base64);
    } catch (err) {
      alert("Error loading preview: " + err);
    }
  }

  async function handleDeleteFolder(path: string) {
    if (!window.confirm(`Are you sure you want to delete this folder?\n${path}`)) return;
    try {
      await invoke("delete_folder", { path });
      setEmptyFolders((prev) => prev.filter((p) => p !== path));
    } catch (err) {
      alert("Error deleting folder: " + err);
    }
  }

  async function handleDeleteAllFolders() {
    if (!window.confirm(`Are you sure you want to delete ALL ${emptyFolders.length} empty folders?`)) return;
    for (const path of emptyFolders) {
      try {
        await invoke("delete_folder", { path });
      } catch (err) {
        console.error("Failed to delete", path, err);
      }
    }
    setEmptyFolders([]);
  }

  async function handleDelete(path: string, isDuplicate = false) {
    if (!window.confirm("Are you sure you want to permanently delete this file? This cannot be undone.")) return;
    try {
      await invoke("delete_file", { path });
      if (isDuplicate) {
        setDuplicateGroups((prev) => 
          prev.map((g) => ({
            ...g,
            files: g.files.filter((f) => f.path !== path)
          })).filter(g => g.files.length > 1)
        );
      } else {
        setFiles((prev) => prev.filter((f) => f.path !== path));
      }
    } catch (err) {
      console.error("Delete Error:", err);
      alert("Failed to delete file: " + err);
    }
  }

  async function handleKeepOne(groupIndex: number) {
    if (!window.confirm("Are you sure you want to delete all other duplicates in this group?")) return;
    const group = duplicateGroups[groupIndex];
    if (!group || group.files.length <= 1) return;
    
    // Keep the first one, delete the rest
    const filesToDelete = group.files.slice(1);
    let successCount = 0;
    
    for (const f of filesToDelete) {
      try {
        await invoke("delete_file", { path: f.path });
        successCount++;
      } catch (err) {
        console.error("Failed to delete", f.path, err);
      }
    }
    
    if (successCount > 0) {
      setDuplicateGroups(prev => prev.filter((_, idx) => idx !== groupIndex));
    }
  }

  async function handleOpen(path: string) {
    try {
      await invoke("open_file", { path });
    } catch (err) {
      console.error("Open Error:", err);
      alert("Failed to open file: " + err);
    }
  }

  function handleCategoryChange(value: FilterType) {
    setFilterType(value);
    if (scanned) {
      startScan(value);
    }
  }

  return (
    <div className="app-layout">
      {/* ===== Sidebar ===== */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img src={logoImg} className="brand-icon-img" alt="DiskRay Pro" />
          <span className="brand-name">DiskRay Pro</span>
        </div>

        <nav className="sidebar-nav">
          <p className="nav-label">Categories</p>
          {categories.map((cat) => (
            <button
              key={cat.value}
              className={`nav-item ${filterType === cat.value ? "active" : ""}`}
              onClick={() => handleCategoryChange(cat.value)}
            >
              <span className="nav-icon">{cat.icon}</span>
              <span>{cat.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          {scanned && !loading && (
            <p className="result-count">
              {filterType === "duplicates" 
                ? `${duplicateGroups.reduce((acc, g) => acc + g.files.length, 0)} files in ${duplicateGroups.length} groups`
                : `${files.length} file${files.length !== 1 ? "s" : ""} found`}
            </p>
          )}
        </div>
      </aside>

      {/* ===== Main Content ===== */}
      <main className="main-content">
        {/* Header */}
        <header className="dashboard-header">
          <div className="header-title">
            <h1>DiskRay Pro</h1>
            <span className="header-sub">Top 100 largest files</span>
          </div>
          <div className="scan-controls">
            <div className="path-input-group">
              <input
                className="path-input"
                type="text"
                value={scanPath}
                onChange={(e) => setScanPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && startScan()}
                placeholder="Enter directory path..."
                spellCheck={false}
              />
              <button
                className="browse-btn"
                onClick={handleBrowse}
                disabled={loading}
              >
                📁 Browse
              </button>
            </div>
            <button
              className={`scan-btn ${!loading && scanPath.trim() ? "active" : "disabled"}`}
              onClick={() => startScan()}
              disabled={loading}
            >
              {loading ? (
                <>
                  <span className="spinner" />
                  Scanning…
                </>
              ) : (
                <>
                  <span>⚡</span> Start Scan
                </>
              )}
            </button>
          </div>
        </header>

        {/* Body */}
        <div className="content-body">
          {/* Custom Extension Input */}
          {filterType === "custom" && (
            <div className="filter-group" style={{ marginBottom: "16px", animation: "slideDown 0.4s ease forwards" }}>
              <label>Extensions:</label>
              <input
                type="text"
                placeholder="e.g. mp4, iso, apk"
                value={customExts}
                onChange={(e) => setCustomExts(e.target.value)}
                disabled={loading}
                style={{ width: "220px" }}
                onKeyDown={(e) => e.key === "Enter" && startScan()}
              />
              <button 
                className={`scan-btn ${!loading ? "active" : "disabled"}`} 
                style={{ height: "32px", padding: "0 16px" }} 
                onClick={() => startScan()} 
                disabled={loading}
              >
                Apply
              </button>
            </div>
          )}

          {/* Advanced Filters */}
          <div className="advanced-filters">
            <div className="filter-group">
              <label>Min Size (MB)</label>
              <input
                type="number"
                min="0"
                placeholder="e.g. 50"
                value={minSizeMB}
                onChange={(e) => setMinSizeMB(e.target.value)}
                disabled={loading}
              />
            </div>
            <div className="filter-group">
              <label>Max Size (MB)</label>
              <input
                type="number"
                min="0"
                placeholder="e.g. 1000"
                value={maxSizeMB}
                onChange={(e) => setMaxSizeMB(e.target.value)}
                disabled={loading}
              />
            </div>
          </div>

          {/* Loading */}
          {loading && (
            <div className="loading-overlay">
              <div className="pulse-spinner" />
              <p className="loading-text">Scanning file system…</p>
              {scanProgress ? (
                <div style={{ textAlign: "center", maxWidth: "80%" }}>
                  <p className="loading-sub" style={{ fontSize: "15px", color: "var(--accent-base)" }}>
                    Scanned: <strong>{scanProgress.scanned_count}</strong> files / folders
                  </p>
                  <p className="loading-sub" style={{ fontSize: "11px", opacity: 0.6, wordBreak: "break-all", marginTop: "8px" }}>
                    {scanProgress.current_path}
                  </p>
                </div>
              ) : (
                <p className="loading-sub">This may take a few seconds</p>
              )}
            </div>
          )}

          {/* Error */}
          {error && !loading && (
            <div className="error-box">
              <span>⚠️</span> {error}
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && !scanned && (
            <div className="empty-state">
              <div className="empty-icon">🔍</div>
              <h2>Ready to Scan</h2>
              <p>Enter a directory path above and click <strong>Start Scan</strong> to explore your files.</p>
            </div>
          )}

          {/* No results */}
          {!loading && !error && scanned && (filterType === "duplicates" ? duplicateGroups.length === 0 : files.length === 0) && (
            <div className="empty-state">
              <div className="empty-icon">📂</div>
              <h2>No Files Found</h2>
              <p>No matching files in <code>{scanPath}</code> for this category.</p>
            </div>
          )}

          {/* Success Message */}
          {!loading && !error && scanned && (filterType === "duplicates" ? duplicateGroups.length > 0 : files.length > 0) && (
            <div className="success-box">
              <div className="success-icon">✅</div>
              <div className="success-text">
                Scan complete! Found <strong>{filterType === "duplicates" ? duplicateGroups.length : files.length}</strong> {filterType === "duplicates" ? "duplicate groups" : "files"} in <code>{scanPath}</code>.
              </div>
            </div>
          )}

          {/* Duplicate Groups List */}
          {!loading && filterType === "duplicates" && duplicateGroups.length > 0 && (
            <div className="duplicates-list">
              {duplicateGroups.length > 50 && (
                <div className="info-box" style={{ marginBottom: "20px", background: "rgba(108, 99, 255, 0.1)", border: "1px solid rgba(108, 99, 255, 0.3)" }}>
                  <span>ℹ️</span> Showing top 50 groups only for performance. ({duplicateGroups.length} groups found in total)
                </div>
              )}
              {duplicateGroups.slice(0, 50).map((group, gIdx) => (
                <div key={group.hash} className="duplicate-group">
                  <div className="duplicate-group-header">
                    <h3>
                      <span className="size-badge">{formatSize(group.size)} Each</span>
                      <span style={{ marginLeft: "12px" }}>Similar Files ({group.files.length})</span>
                    </h3>
                    <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                      <span className="duplicate-hash">Hash: {group.hash.substring(0,8)}</span>
                      <button className="action-btn keep-one-btn" style={{ width: "auto", padding: "6px 16px" }} onClick={() => handleKeepOne(gIdx)}>
                        🧹 Keep One
                      </button>
                    </div>
                  </div>
                  <table className="file-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Name</th>
                        <th>Path</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.files.map((file, fIdx) => (
                        <tr key={`${file.path}-${fIdx}`} className="file-row">
                          <td className="col-index">{fIdx + 1}</td>
                          <td className="col-name" title={file.name}>
                            <span className="file-icon">{getIcon(file.extension)}</span>
                            <span className="file-name-text">{file.name}</span>
                          </td>
                          <td className="col-path" title={file.path}>{file.path}</td>
                          <td className="col-actions">
                            <button 
                              className="action-btn open-btn" 
                              title="Open File" 
                              onClick={() => handleOpen(file.path)}
                            >📂</button>
                            <button 
                              className="action-btn delete-btn" 
                              title="Delete File" 
                              onClick={() => handleDelete(file.path, true)}
                            >🗑️</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}

          {/* Empty Folders List */}
          {!loading && scanned && filterType === "empty_folders" && (
            <div className="table-wrapper">
              <div style={{ padding: "20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border)" }}>
                <h3 style={{ margin: 0, color: "var(--text-primary)" }}>Empty Directory Explorer</h3>
                {emptyFolders.length > 0 && (
                  <button 
                    className="scan-btn active" 
                    style={{ height: "36px", background: "var(--error)", padding: "0 20px" }} 
                    onClick={handleDeleteAllFolders}
                  >
                    🗑️ Delete All ({emptyFolders.length})
                  </button>
                )}
              </div>
              <table className="file-table">
                <thead>
                  <tr>
                    <th style={{ width: "60px" }}>#</th>
                    <th>Folder Path</th>
                    <th style={{ width: "120px" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {emptyFolders.length === 0 ? (
                    <tr>
                      <td colSpan={3} style={{ textAlign: "center", padding: "60px", color: "var(--text-muted)" }}>
                        <div style={{ fontSize: "40px", marginBottom: "16px" }}>🎉</div>
                        Your system is clean! No empty folders found.
                      </td>
                    </tr>
                  ) : (
                    emptyFolders.map((path, index) => (
                      <tr key={path} className="file-row">
                        <td className="col-index">{index + 1}</td>
                        <td className="col-path" style={{ color: "var(--text-primary)" }}>{path}</td>
                        <td className="col-actions">
                          <button className="action-btn delete-btn" title="Delete Folder" onClick={() => handleDeleteFolder(path)}>🗑️</button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* File Table */}
          {!loading && filterType !== "duplicates" && files.length > 0 && (
            <div className="table-wrapper">
              <table className="file-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Name</th>
                    <th>Size</th>
                    <th>Extension</th>
                    <th>Created At</th>
                    <th>Modified At</th>
                    <th>Path</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((file, index) => (
                    <tr key={`${file.path}-${index}`} className="file-row">
                      <td className="col-index">{index + 1}</td>
                      <td className="col-name" title={file.name}>
                        <span className="file-icon">{getIcon(file.extension)}</span>
                        <span className="file-name-text">{file.name}</span>
                      </td>
                      <td className="col-size">
                        <span className="size-badge">{formatSize(file.size)}</span>
                      </td>
                      <td className="col-ext">
                        {file.extension ? (
                          <span className="ext-tag">.{file.extension}</span>
                        ) : (
                          <span className="ext-none">—</span>
                        )}
                      </td>
                      <td style={{ color: "var(--text-secondary)", fontSize: "12px", whiteSpace: "nowrap" }}>{formatDate(file.created_at)}</td>
                      <td style={{ color: "var(--text-secondary)", fontSize: "12px", whiteSpace: "nowrap" }}>{formatDate(file.modified_at)}</td>
                      <td className="col-path" title={file.path}>
                        {file.path}
                      </td>
                      <td className="col-actions">
                        <button 
                          className="action-btn open-btn" 
                          title="Open File" 
                          onClick={() => handleOpen(file.path)}
                        >
                          📂
                        </button>
                        {["jpg", "jpeg", "png", "webp", "gif"].includes(file.extension) && (
                          <button 
                            className="action-btn open-btn" 
                            style={{ borderColor: "var(--accent-base)" }}
                            title="Preview Image" 
                            onClick={() => handlePreview(file.path)}
                          >
                            👁️
                          </button>
                        )}
                        <button 
                          className="action-btn delete-btn" 
                          title="Delete File" 
                          onClick={() => handleDelete(file.path)}
                        >
                          🗑️
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
      {/* Preview Modal */}
      {previewImage && (
        <div className="modal-overlay" onClick={() => setPreviewImage(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setPreviewImage(null)}>✕</button>
            <div className="modal-body">
              <img src={previewImage} alt="Preview" className="preview-img" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ================== Icon Helper ==================
function getIcon(ext: string): string {
  const images = ["jpg", "jpeg", "png", "webp", "gif", "svg", "bmp"];
  const archives = ["zip", "rar", "7z", "gz", "tar", "bz2"];
  const docs = ["pdf", "docx", "doc", "txt", "xlsx", "xls", "pptx", "csv"];
  const video = ["mp4", "mkv", "avi", "mov", "webm"];
  const audio = ["mp3", "flac", "wav", "ogg", "aac"];
  const code = ["rs", "ts", "tsx", "js", "py", "go", "cpp", "c", "java", "sh"];

  if (images.includes(ext)) return "🖼️";
  if (archives.includes(ext)) return "📦";
  if (docs.includes(ext)) return "📄";
  if (video.includes(ext)) return "🎬";
  if (audio.includes(ext)) return "🎵";
  if (code.includes(ext)) return "💾";
  return "📁";
}

export default App;