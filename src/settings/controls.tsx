import { useId, useState, type ReactNode } from "react";

import { sliderCommitValue } from "../reader/settings/normalize";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./sections";

/** 设置页各分区的共用上下文：settings 表快照 + 写入通道（SettingsPage 提供） */
export type SettingsCtx = {
  /** settings 表快照：进页整表读取一次，写入即时合并——各分区的控件都是它的纯函数 */
  map: Record<string, string>;
  /** 只改本地快照（持久化由调用方自理，如 closeAction 自带写库与缓存） */
  patch: (values: Record<string, string>) => void;
  /** 写单键：快照即时合并 + 落库。失败 toast，但 resolve 不 reject——需要"写完再广播"的调用方可 await */
  put: (key: string, value: string) => Promise<void>;
  /** 批量写（一次 IPC） */
  putMany: (values: Record<string, string>) => Promise<void>;
  version: string;
};

/** 分区抬头：分区名 + 一句说明（取自登记表；顶栏 h1 恒为「设置」，这里是被选中分区的名字）；note=需要常驻的提醒 */
export function SectionHeader(props: { id: SettingsSectionId; note?: ReactNode }) {
  const meta = SETTINGS_SECTIONS.find((s) => s.id === props.id);
  return (
    <header className="wr-settings-head">
      <h2 className="wr-settings-title">{meta?.label}</h2>
      <p className="wr-settings-desc">{meta?.desc}</p>
      {props.note ? <p className="wr-settings-note">{props.note}</p> : null}
    </header>
  );
}

/** 分区内的分组：小标题 + 若干设置行 */
export function SettingsGroup(props: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="wr-settings-block" aria-labelledby={id}>
      <h3 className="wr-settings-group" id={id}>
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

/** 设置行：左=名称+说明，右=控件（窄容器下自动上下堆叠，见 weread.css 容器查询） */
export function SettingsRow(props: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="wr-settings-row">
      <div className="wr-settings-main">
        <div className="wr-settings-label">{props.label}</div>
        {props.hint != null && props.hint !== "" ? <div className="wr-settings-hint">{props.hint}</div> : null}
      </div>
      {props.children != null ? <div className="wr-settings-ctrl">{props.children}</div> : null}
    </div>
  );
}

/** 段控（互斥单选），沿用 .wr-seg 视觉 */
export function Seg<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; text: string; disabled?: boolean }[];
  onPick: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="wr-seg" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="wr-seg-btn"
          data-active={props.value === o.value}
          aria-pressed={props.value === o.value}
          disabled={props.disabled || o.disabled}
          onClick={() => props.onPick(o.value)}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

/** 滑杆：拖动只预览数值，松手 / 键盘 / 失焦才提交（避免逐档落库） */
export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onCommit: (v: number) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? props.value;
  const commit = () => {
    const next = sliderCommitValue(draft, props.value);
    setDraft(null);
    if (next !== null) props.onCommit(next);
  };
  return (
    <span className="wr-settings-slider">
      <input
        type="range"
        aria-label={props.label}
        aria-valuetext={props.format(shown)}
        min={props.min}
        max={props.max}
        step={props.step}
        value={shown}
        disabled={props.disabled}
        onChange={(e) => setDraft(Number(e.currentTarget.value))}
        onPointerUp={commit}
        onPointerCancel={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="wr-settings-slider-value">{props.format(shown)}</span>
    </span>
  );
}

/** 开关：复选框 + 说明文字（文字即复选框的可访问名） */
export function Check(props: { text: ReactNode; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <label className="wr-settings-check">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      {props.text}
    </label>
  );
}
