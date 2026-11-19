// epubjs 上游 bug 补丁（极品家丁章节 logo blob 错配的根因修复）。
// Resources.replacements() 把 createUrl 失败的条目从 replacementUrls 里 filter 掉，
// 数组被压缩、后续 substitute(content, urls, replacements) 的 index 配对整体前移——
// 某资源失败后，排在它后面的资源会拿到错误的 blob。
// substitute() 本就跳过 falsy 的 replacements[i]，null 占位即可恢复对齐。
// 注意：必须从运行实例取 prototype 打补丁——Vite 依赖优化会把 "epubjs" 主入口与
// "epubjs/lib/*" 深路径解析成两份模块实例，直接 import 深路径打到的类不在运行链上。
type AnyResources = {
  settings: { replacements?: string };
  urls: string[];
  createUrl(url: string): Promise<string>;
  replacementUrls: (string | null)[];
};

/** 对 book.resources / book.archive 的实际类打补丁；在 book.ready 后、display 前调用 */
export function patchEpubjsBook(book: unknown): void {
  const b = book as { resources?: AnyResources; archive?: unknown } | null;
  if (!b) return;
  const resProto = b.resources ? (Object.getPrototypeOf(b.resources) as Record<string, unknown> | null) : null;
  if (resProto && !resProto.__wrAligned) {
    resProto.__wrAligned = true;
    resProto.replacements = function (this: AnyResources) {
      if (this.settings.replacements === "none") return Promise.resolve(this.urls);
      return Promise.all(
        this.urls.map((url) => this.createUrl(url).catch(() => null)),
      ).then((replacementUrls) => {
        // 不 filter：失败条目保留 null 占位，index 与 this.urls 一一对应
        this.replacementUrls = replacementUrls;
        return replacementUrls;
      });
    };
  }
}
