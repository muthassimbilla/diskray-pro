use serde::Serialize;
use walkdir::WalkDir;
use std::collections::HashMap;
use std::io::Read;
use tauri::Emitter;

#[derive(Clone, Serialize)]
struct ProgressPayload {
    scanned_count: u64,
    current_path: String,
}

#[derive(Serialize)]
pub struct FileInfo {
    name: String,
    path: String,
    size: u64,
    extension: String,
    created_at: u64,
    modified_at: u64,
}

#[derive(Serialize)]
pub struct DuplicateGroup {
    pub hash: String,
    pub size: u64,
    pub files: Vec<FileInfo>,
}

#[tauri::command]
async fn scan_files(
    app: tauri::AppHandle,
    path: String,
    filter_type: String,
    min_size: Option<u64>,
    max_size: Option<u64>,
) -> Result<Vec<FileInfo>, String> {
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut scanned_count = 0;
        let mut files: Vec<FileInfo> = WalkDir::new(&path)
            .into_iter()
            .filter_map(|e| {
                scanned_count += 1;
                if scanned_count % 500 == 0 {
                    if let Ok(entry) = &e {
                        let _ = app_clone.emit("scan_progress", ProgressPayload {
                            scanned_count,
                            current_path: entry.path().to_string_lossy().to_string(),
                        });
                    }
                }
                e.ok()
            })
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            let ext = entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();

            // filter_type অনুযায়ী ফাইল ফিল্টার করা
            let is_custom = filter_type.starts_with("custom:");
            let matches = match filter_type.as_str() {
                "images" => matches!(
                    ext.as_str(),
                    "jpg" | "jpeg" | "png" | "webp" | "gif"
                ),
                "archives" => {
                    // .tar.gz এর জন্য আলাদা চেক
                    let full_name = entry
                        .file_name()
                        .to_string_lossy()
                        .to_lowercase();
                    matches!(ext.as_str(), "zip" | "rar" | "7z")
                        || full_name.ends_with(".tar.gz")
                }
                "documents" => matches!(
                    ext.as_str(),
                    "pdf" | "docx" | "txt" | "xlsx"
                ),
                _ if is_custom => {
                    let custom_exts = filter_type.trim_start_matches("custom:");
                    let custom_list: Vec<String> = custom_exts.split(',').map(|s| s.trim().to_lowercase()).collect();
                    custom_list.contains(&ext)
                },
                // "all" বা যেকোনো unknown value → সব ফাইল
                _ => true,
            };

            if !matches {
                return None;
            }

            let size = metadata.len();
            if let Some(min) = min_size {
                if size < min {
                    return None;
                }
            }
            if let Some(max) = max_size {
                if size > max {
                    return None;
                }
            }
            
            let created_at = metadata.created().map(|time| time.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()).unwrap_or(0);
            let modified_at = metadata.modified().map(|time| time.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()).unwrap_or(0);

            Some(FileInfo {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                size,
                extension: ext,
                created_at,
                modified_at,
            })
        })
        .collect();

    // সবচেয়ে বড় ফাইল আগে — descending sort by size
    files.sort_by(|a, b| b.size.cmp(&a.size));

    // Top 100 ফাইল return করা
    files.into_iter().take(100).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn find_duplicates(app: tauri::AppHandle, path: String) -> Result<Vec<DuplicateGroup>, String> {
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut size_map: HashMap<u64, Vec<FileInfo>> = HashMap::new();
        
        let mut scanned_count = 0;
        for e in WalkDir::new(&path).into_iter() {
            scanned_count += 1;
            if scanned_count % 500 == 0 {
                if let Ok(entry) = &e {
                    let _ = app_clone.emit("scan_progress", ProgressPayload {
                        scanned_count,
                        current_path: entry.path().to_string_lossy().to_string(),
                    });
                }
            }
            let entry = match e {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let size = metadata.len();
            if size == 0 {
                continue;
            }
            
            let ext = entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
                
            let created_at = metadata.created().map(|time| time.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()).unwrap_or(0);
            let modified_at = metadata.modified().map(|time| time.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()).unwrap_or(0);
                
            let file_info = FileInfo {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                size,
                extension: ext,
                created_at,
                modified_at,
            };
            size_map.entry(size).or_insert_with(Vec::new).push(file_info);
        }
        
        let mut potential_duplicates = Vec::new();
        for (_, files) in size_map {
            if files.len() > 1 {
                potential_duplicates.extend(files);
            }
        }
        
        let mut hash_map: HashMap<String, Vec<FileInfo>> = HashMap::new();
        let mut buf = vec![0u8; 65536]; // Increased to 64KB for better throughput
        
        let total_potential = potential_duplicates.len();
        let mut processed_count = 0;
        
        // Phase 2: Fast Hash (First 16KB) to narrow down candidates
        let mut fast_hash_groups: HashMap<String, Vec<FileInfo>> = HashMap::new();
        for file in potential_duplicates {
            processed_count += 1;
            if processed_count % 20 == 0 || processed_count == total_potential {
                let _ = app_clone.emit("scan_progress", ProgressPayload {
                    scanned_count: processed_count as u64,
                    current_path: format!("Checking file signatures ({}/{})...", processed_count, total_potential),
                });
            }

            if let Ok(mut f) = std::fs::File::open(&file.path) {
                let mut fast_buf = [0u8; 16384]; // 16KB
                let n = f.read(&mut fast_buf).unwrap_or(0);
                let mut hasher = blake3::Hasher::new();
                hasher.update(&fast_buf[..n]);
                let hash = hasher.finalize().to_hex().to_string();
                fast_hash_groups.entry(hash).or_insert_with(Vec::new).push(file);
            }
        }

        // Phase 3: Full Hash only for those that matched fast-hash and size
        let mut final_candidates = Vec::new();
        for (_, files) in fast_hash_groups {
            if files.len() > 1 {
                final_candidates.extend(files);
            }
        }

        let total_final = final_candidates.len();
        let mut final_count = 0;

        for file in final_candidates {
            final_count += 1;
            let _ = app_clone.emit("scan_progress", ProgressPayload {
                scanned_count: final_count as u64,
                current_path: format!("Deep scanning duplicates ({}/{})...", final_count, total_final),
            });

            if let Ok(mut f) = std::fs::File::open(&file.path) {
                let mut hasher = blake3::Hasher::new();
                loop {
                    match f.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            hasher.update(&buf[..n]);
                        }
                        Err(_) => break,
                    }
                }
                let hash = hasher.finalize().to_hex().to_string();
                hash_map.entry(hash).or_insert_with(Vec::new).push(file);
            }
        }
        
        let mut results: Vec<DuplicateGroup> = Vec::new();
        for (hash, files) in hash_map {
            if files.len() > 1 {
                let size = files[0].size;
                results.push(DuplicateGroup {
                    hash,
                    size,
                    files,
                });
            }
        }
        
        results.sort_by(|a, b| b.size.cmp(&a.size));
        results
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_folder(path: String) -> Result<(), String> {
    std::fs::remove_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_image_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    Ok(format!("data:image/{};base64,{}", ext, b64))
}

#[tauri::command]
async fn find_empty_folders(app: tauri::AppHandle, path: String) -> Result<Vec<String>, String> {
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut empty_folders = Vec::new();
        let mut scanned_count = 0;
        
        for entry in WalkDir::new(&path).into_iter().filter_map(|e| e.ok()) {
            scanned_count += 1;
            if scanned_count % 500 == 0 {
                let _ = app_clone.emit("scan_progress", ProgressPayload {
                    scanned_count,
                    current_path: entry.path().to_string_lossy().to_string(),
                });
            }
            
            if entry.file_type().is_dir() {
                if let Ok(mut read_dir) = std::fs::read_dir(entry.path()) {
                    if read_dir.next().is_none() {
                        empty_folders.push(entry.path().to_string_lossy().to_string());
                    }
                }
            }
        }
        empty_folders
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let res = std::process::Command::new("xdg-open").arg(&path).spawn();

    #[cfg(target_os = "windows")]
    let res = std::process::Command::new("cmd").args(&["/C", "start", "", &path]).spawn();

    #[cfg(target_os = "macos")]
    let res = std::process::Command::new("open").arg(&path).spawn();

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let res: Result<std::process::Child, std::io::Error> = Err(std::io::Error::new(std::io::ErrorKind::Other, "Unsupported OS"));

    res.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_files, 
            delete_file, 
            delete_folder,
            open_file, 
            find_duplicates,
            get_image_base64,
            find_empty_folders
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
