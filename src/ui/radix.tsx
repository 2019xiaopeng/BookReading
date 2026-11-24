import { useRef, type CSSProperties, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-menu";
import * as Select from "@radix-ui/react-select";
import * as RTooltip from "@radix-ui/react-tooltip";

/**
 * V-2 Radix 基座：只取行为层（键盘导航/焦点陷阱/外点关闭/滚动锁定），视觉层全部沿用碳墨
 * 既有类（wr-menu / wr-prompt-overlay / wr-select / …），不带任何 Radix 默认样式。
 */

// ─────────────────── Menu：视口坐标锚的受控菜单 ───────────────────

export type MenuPoint = { x: number; y: number };

function pointRect(p: MenuPoint): DOMRect {
  // floating-ui 只读这些字段；0 尺寸锚让菜单从坐标点向下展开（碰撞翻转交给 Radix，替代旧手搓 clamp）
  return {
    x: p.x,
    y: p.y,
    top: p.y,
    left: p.x,
    right: p.x,
    bottom: p.y,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

/** 右键 / ⋯ 菜单宿主：open 时挂载（每次打开都是新实例，锚点取当次坐标）。 */
export function PointMenu(props: {
  point: MenuPoint;
  onClose: () => void;
  label?: string;
  contentClassName?: string;
  contentStyle?: CSSProperties;
  children: ReactNode;
}) {
  // 虚拟锚闭包跟随最新 point（同位置复用实例换菜单时坐标不滞留）
  const virtualRef = useRef<{ getBoundingClientRect: () => DOMRect }>({
    getBoundingClientRect: () => pointRect(props.point),
  });
  virtualRef.current.getBoundingClientRect = () => pointRect(props.point);
  return (
    <Menu.Root open onOpenChange={(o) => { if (!o) props.onClose(); }}>
      <Menu.Anchor virtualRef={virtualRef} />
      <Menu.Portal>
        <Menu.Content
          loop
          className={`wr-menu wr-menu--radix ${props.contentClassName ?? ""}`}
          style={props.contentStyle}
          aria-label={props.label}
          sideOffset={0}
          collisionPadding={8}
          // 焦点回触发钮由调用方 onClose 自理（Radix 的默认回焦对象是虚拟锚，无处可回）
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {props.children}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** 触发钮锚定的下拉（筛选菜单）：返回触发钮左下角坐标，配合 PointMenu 使用。 */
export function anchorBelow(el: HTMLElement | null): MenuPoint {
  const r = el?.getBoundingClientRect();
  return r ? { x: r.left, y: r.bottom + 6 } : { x: 8, y: 8 };
}

// ─────────────────── Dialog：居中模态弹窗宿主 ───────────────────

/** 焦点陷阱 / Esc / 点遮罩 / 背景滚动锁定全由 Radix 承担；面板视觉沿用 wr-panel 体系。 */
export function Modal(props: {
  label: string;
  onClose: () => void;
  panelClassName?: string;
  panelStyle?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) props.onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="wr-prompt-overlay" />
        <Dialog.Content asChild>
          <div
            style={{
              position: "fixed",
              inset: 0,
              display: "grid",
              placeItems: "center",
              zIndex: "var(--wr-z-overlay)",
              pointerEvents: "none",
            }}
          >
            <div
              className={props.panelClassName ?? "wr-panel wr-prompt"}
              style={{ ...props.panelStyle, pointerEvents: "auto" }}
              role="dialog"
              aria-modal="true"
              aria-label={props.label}
            >
              {props.children}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─────────────────── Select：碳墨化下拉（键盘/type-ahead/Esc） ───────────────────

export function WrSelect(props: {
  value: string | number;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <Select.Root value={String(props.value)} onValueChange={props.onChange}>
      <Select.Trigger className={`wr-select wr-select--radix ${props.className ?? ""}`} aria-label={props.ariaLabel}>
        <Select.Value />
        <Select.Icon className="wr-select-caret" aria-hidden="true">
          ▾
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="wr-menu wr-menu--radix" position="popper" sideOffset={6} collisionPadding={8}>
          <Select.Viewport className="wr-select-viewport">
            {props.options.map((o) => (
              <Select.Item key={o.value} value={o.value} className="wr-menu-item wr-select-item">
                <Select.ItemText>{o.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

// ─────────────────── Tooltip：窄窗图标栏悬停提示 ───────────────────

/** 全局 Provider（AppShell / ReaderPage 各挂一份；delay 略长防扫过误弹）。 */
export function TooltipProvider(props: { children: ReactNode }) {
  return <RTooltip.Provider delayDuration={350}>{props.children}</RTooltip.Provider>;
}

/** content 为 null 时原样透传（宽屏无 Tooltip 的同一份 JSX 不必写两遍）。
 * 自带内层 Provider：AppShell/ReaderPage 的全局 Provider 之上嵌套合法，任何落单调用点也不炸。 */
export function Tooltip(props: { content: ReactNode; side?: "top" | "right" | "bottom" | "left"; children: ReactNode }) {
  if (props.content == null) return <>{props.children}</>;
  return (
    <RTooltip.Provider delayDuration={350}>
      <RTooltip.Root>
        <RTooltip.Trigger asChild>{props.children}</RTooltip.Trigger>
        <RTooltip.Portal>
          <RTooltip.Content side={props.side ?? "bottom"} sideOffset={6} className="wr-tooltip">
            {props.content}
            <RTooltip.Arrow className="wr-tooltip-arrow" width={10} height={5} />
          </RTooltip.Content>
        </RTooltip.Portal>
      </RTooltip.Root>
    </RTooltip.Provider>
  );
}
