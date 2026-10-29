use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Book {
    pub id: String,
    pub title: Option<String>,
    pub author: Option<String>,
    pub cover_path: Option<String>,
    pub library_path: String,
    pub added_at: i64,
    pub last_opened_at: Option<i64>,
    pub note: Option<String>,
    pub pinned_at: Option<i64>,
    pub format: Option<String>,
    pub page_count: Option<i64>,
    pub reading_percent: Option<f64>,
    pub is_favorite: bool,
    pub shelf_id: Option<i64>,
    pub sort_order: Option<i64>,
    pub deleted_at: Option<i64>,
    pub description: Option<String>,
    pub content_chars: Option<i64>,
    pub file_size: Option<i64>,
    // 仅 list_books（fetch_books）填充；其余构造点为空
    #[serde(default)]
    pub tags: Vec<BookTagBrief>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookTagBrief {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i64,
    pub book_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shelf {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub sort_order: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportBookRequest {
    pub source_path: String,
    pub title: Option<String>,
    pub author: Option<String>,
    pub cover_bytes_base64: Option<String>,
    pub cover_ext: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateBookMetadataRequest {
    pub book_id: String,
    pub title: Option<String>,
    pub note: Option<String>,
    pub pinned: Option<bool>,
    // author/description 沿用 note 语义：None 不改、Some("") 清除
    pub author: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadingState {
    pub book_id: String,
    pub cfi: String,
    pub percent: Option<f64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: String,
    pub book_id: String,
    pub cfi: String,
    pub label: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Highlight {
    pub id: String,
    pub book_id: String,
    pub cfi_range: String,
    pub color: String,
    pub note: Option<String>,
    // 选中文本（quick-highlight 迁移后与 note 分离：text=原文，note=纯笔记）
    #[serde(default)]
    pub text: Option<String>,
    pub created_at: i64,
}

/// 漫画页元数据：与 list_image_pages 顺序逐 index 对齐
#[derive(Debug, Clone, Serialize)]
pub struct PageMetaOut {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoriteQuote {
    pub id: String,
    pub book_id: String,
    pub cfi_range: String,
    pub text: String,
    pub note: Option<String>,
    pub created_at: i64,
}
