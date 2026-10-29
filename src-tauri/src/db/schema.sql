PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS shelves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER NULL REFERENCES shelves(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT,
  author TEXT,
  cover_path TEXT,
  library_path TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  note TEXT,
  group_name TEXT,
  pinned_at INTEGER,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  format TEXT,
  page_count INTEGER,
  shelf_id INTEGER NULL REFERENCES shelves(id) ON DELETE SET NULL,
  sort_order INTEGER NULL,
  deleted_at INTEGER NULL,
  description TEXT NULL,
  content_chars INTEGER NULL,
  file_size INTEGER NULL
);

CREATE TABLE IF NOT EXISTS reading_state (
  book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  cfi TEXT NOT NULL,
  percent REAL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  cfi TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  cfi_range TEXT NOT NULL,
  color TEXT NOT NULL,
  note TEXT,
  text TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- 契约写 book_id INTEGER，但 books.id 是 TEXT，此处跟随实际类型
CREATE TABLE IF NOT EXISTS book_tags (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(book_id, tag_id)
);

CREATE TABLE IF NOT EXISTS favorite_quotes (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  cfi_range TEXT NOT NULL,
  text TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);

-- EPUB 分页 locations 缓存（epubjs 生成结果按 book_id+档位持久化，换字体字号档才重算）
CREATE TABLE IF NOT EXISTS book_locations (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(book_id, cache_key)
);

-- 阅读时长：每书每日一行累加（date 为本地日期 YYYY-MM-DD）
CREATE TABLE IF NOT EXISTS reading_sessions (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(book_id, date)
);

-- 二级索引（书库增长后 book_id/shelf_id 点查不再全表扫）
CREATE INDEX IF NOT EXISTS idx_books_shelf_id ON books(shelf_id);
CREATE INDEX IF NOT EXISTS idx_book_tags_book_id ON book_tags(book_id);
CREATE INDEX IF NOT EXISTS idx_highlights_book_id ON highlights(book_id);
CREATE INDEX IF NOT EXISTS idx_reading_state_book_id ON reading_state(book_id);
