import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // 技能/代理目录不是项目测试（避免 "No test suite found" 噪声失败）
    exclude: ["**/node_modules/**", "**/dist/**", ".agents/**", ".claude/**"],
  },
});
