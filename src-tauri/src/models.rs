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
    pub created_at: i64,
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
