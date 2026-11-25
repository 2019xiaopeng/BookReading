// F-2（U-11/U-12）网络设置区：wenku8 地址三选 + 连通状态行 + 代理三键。
// v3.2（V-3）：迁入设置大页面「网络与更新」分区——行结构改用 SettingsRow，下拉换主题化的 WrSelect。
import { useEffect, useState } from "react";

import { getSettings, setSetting } from "../tauri/invoke";
import { wenku8EndpointStatus, type Wenku8EndpointStatus } from "../tauri/wenku8";
import { WrSelect } from "./radix";
import { SettingsRow } from "../settings/controls";

const ENDPOINT_OPTIONS: { value: "auto" | "relay" | "direct"; label: string }[] = [
  { value: "auto", label: "自动（中继不通切直连）" },
  { value: "relay", label: "中继 wenku8-relay.mewx.org" },
  { value: "direct", label: "直连 app.wenku8.com" },
];

/** 端口串合法 = 空（未填）或 1-65535 整数 */
export function proxyPortValid(port: string): boolean {
  if (port.trim() === "") return true;
  return /^\d+$/.test(port.trim()) && +port.trim() >= 1 && +port.trim() <= 65535;
}

export default function NetworkSettings() {
  const [endpoint, setEndpoint] = useState<"auto" | "relay" | "direct">("auto");
  const [status, setStatus] = useState<Wenku8EndpointStatus | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [proxyOn, setProxyOn] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const s = await getSettings();
        if (s["wenku8.endpoint"] === "relay" || s["wenku8.endpoint"] === "direct") {
          setEndpoint(s["wenku8.endpoint"]);
        }
        setHost(s["proxy.host"] ?? "");
        setPort(s["proxy.port"] ?? "");
        setProxyOn(s["proxy.enabled"] === "1");
      } catch {
        // 读不到设置保持默认展示
      }
      try {
        setStatus(await wenku8EndpointStatus()); // 打开设置时刷新一次连通状态
      } catch {
        // 探测失败留空行
      }
    })();
  }, []);

  const sessionLabel =
    status == null
      ? ""
      : status.setting === "relay"
        ? "当前固定走中继"
        : status.setting === "direct"
          ? "当前固定走直连"
          : status.session === "relay" || status.session === "direct"
            ? `自动模式本会话在用${status.session === "relay" ? "中继" : "直连"}`
            : "自动模式（会话未发生切换）";

  return (
    <>
      <SettingsRow
        label="文库地址"
        hint={
          status
            ? `${sessionLabel} · 中继${status.relay_ok ? "可达" : "不可达"} · 直连${status.direct_ok ? "可达" : "不可达"}`
            : "连通状态探测中…"
        }
      >
        <WrSelect
          ariaLabel="wenku8 地址"
          value={endpoint}
          options={ENDPOINT_OPTIONS}
          onChange={(v) => {
            const next = v as "auto" | "relay" | "direct";
            setEndpoint(next);
            void setSetting("wenku8.endpoint", next);
          }}
        />
      </SettingsRow>

      <SettingsRow
        label="代理"
        hint={
          proxyPortValid(port)
            ? "HTTP 代理，应用于云书架请求、应用内更新（检查与下载）与备用下载通道"
            : "端口需为 1-65535 的整数，当前值未保存"
        }
      >
        <label className="wr-settings-check" style={{ whiteSpace: "nowrap" }}>
          <input
            type="checkbox"
            checked={proxyOn}
            aria-label="启用代理"
            onChange={(e) => {
              const on = e.currentTarget.checked;
              setProxyOn(on);
              void setSetting("proxy.enabled", on ? "1" : "0");
            }}
          />
          启用
        </label>
        <input
          className="wr-input"
          style={{ width: 160, padding: "6px 12px" }}
          value={host}
          placeholder="主机，如 127.0.0.1"
          aria-label="代理主机"
          disabled={!proxyOn}
          onChange={(e) => setHost(e.currentTarget.value)}
          onBlur={() => void setSetting("proxy.host", host.trim())}
        />
        <input
          className="wr-input"
          style={{ width: 90, padding: "6px 12px" }}
          value={port}
          placeholder="端口"
          aria-label="代理端口"
          disabled={!proxyOn}
          inputMode="numeric"
          onChange={(e) => setPort(e.currentTarget.value)}
          onBlur={() => {
            if (proxyPortValid(port)) void setSetting("proxy.port", port.trim());
          }}
        />
      </SettingsRow>
    </>
  );
}
