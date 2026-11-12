import {
  describeFields,
  toDiagnostic,
  toHex,
  toPlain,
  type CborParseResult,
} from '../lib/cbor';
import type { UrResult } from '../lib/ur-session';
import { el } from './dom';
import { toast } from './toast';

export interface ResultModel {
  result: UrResult;
  cbor: CborParseResult;
  text: string | null;
}

type TabId = 'summary' | 'cbor' | 'json' | 'hex' | 'ur';

interface TabDef {
  id: TabId;
  label: string;
}

const MAX_PREVIEW_TEXT = 4000;

export function formatBytes(count: number): string {
  if (count < 1024) return `${count} B`;
  const units = ['kB', 'MB', 'GB'];
  let value = count / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function isSensitiveType(type: string): boolean {
  return type.startsWith('crypto-');
}

function payloadExtension(type: string): string {
  if (type === 'crypto-psbt') return '.psbt';
  if (type === 'bytes') return '.bin';
  return '.cbor';
}

function saveFile(filename: string, data: BlobPart, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const link = el('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a scratch textarea.
    try {
      const area = el('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Renders the decoded payload with tabs for the different representations. */
export class ResultView {
  private model: ResultModel | null = null;
  private activeTab: TabId = 'summary';
  private panel: HTMLElement | null = null;
  private tabBar: HTMLElement | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly badge: HTMLElement,
    private readonly onReset: () => void,
  ) {
    this.showEmpty();
  }

  showEmpty(): void {
    this.model = null;
    this.panel = null;
    this.tabBar = null;
    this.badge.hidden = true;

    const wrapper = el('div', 'empty');
    wrapper.append(
      el('p', 'empty-title', 'Nothing decoded yet'),
      el('p', 'empty-text', 'Frames are captured and reassembled here the moment a UR code is recognised.'),
    );

    const tips = el('ul', 'empty-tips');
    for (const tip of [
      'Animated codes repeat — keep the whole code inside the brackets.',
      'Dense payloads can need dozens of frames. Watch the progress bar, not the screen.',
      'No second device handy? Open “Test generator” and scan this screen.',
    ]) {
      tips.append(el('li', undefined, tip));
    }
    wrapper.append(tips);

    this.host.replaceChildren(wrapper);
  }

  show(model: ResultModel): void {
    this.model = model;
    this.activeTab = 'summary';
    this.badge.hidden = false;
    this.badge.textContent = model.result.type;
    this.render();
  }

  private render(): void {
    const model = this.model;
    if (!model) return;

    const container = el('div');
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '14px';

    container.append(this.buildStats(model));

    if (isSensitiveType(model.result.type)) {
      const notice = el('div', 'notice');
      notice.append(
        el('span', 'notice-icon', '⚠'),
        el(
          'span',
          undefined,
          'This payload is wallet secret material. It was decoded in this tab only and never uploaded — store it accordingly.',
        ),
      );
      container.append(notice);
    }

    const tabs = this.tabsFor(model);
    const tabBar = el('div', 'tabs');
    tabBar.setAttribute('role', 'tablist');
    this.tabBar = tabBar;

    const panel = el('div', 'panel');
    panel.id = 'tab-panel';
    panel.setAttribute('role', 'tabpanel');
    this.panel = panel;

    for (const tab of tabs) {
      const button = el('button', 'tab', tab.label);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.dataset.tab = tab.id;
      button.addEventListener('click', () => {
        this.activeTab = tab.id;
        this.renderPanel();
      });
      tabBar.append(button);
    }

    container.append(tabBar, panel, this.buildActions());
    this.host.replaceChildren(container);
    this.renderPanel();
  }

  private tabsFor(model: ResultModel): TabDef[] {
    const tabs: TabDef[] = [{ id: 'summary', label: 'Summary' }];
    if (model.cbor.ok) {
      tabs.push({ id: 'cbor', label: 'CBOR' }, { id: 'json', label: 'JSON' });
    }
    tabs.push({ id: 'hex', label: 'Hex' });
    if (model.result.uri) tabs.push({ id: 'ur', label: 'UR' });
    return tabs;
  }

  private renderPanel(): void {
    const model = this.model;
    const panel = this.panel;
    if (!model || !panel) return;

    for (const button of this.tabBar?.querySelectorAll<HTMLButtonElement>('.tab') ?? []) {
      button.setAttribute('aria-selected', String(button.dataset.tab === this.activeTab));
    }

    const text = this.tabText(this.activeTab, model);
    if (this.activeTab === 'summary') {
      panel.replaceChildren(this.summaryNode(model));
      return;
    }
    const pre = el('pre', 'code');
    pre.textContent = text || '(empty)';
    panel.replaceChildren(pre);
  }

  private tabText(tab: TabId, model: ResultModel): string {
    switch (tab) {
      case 'summary':
        return this.summaryText(model);
      case 'cbor':
        return model.cbor.ok ? toDiagnostic(model.cbor.node) : '';
      case 'json':
        return model.cbor.ok ? JSON.stringify(toPlain(model.cbor.node), null, 2) : '';
      case 'hex':
        return toHex(model.result.payload);
      case 'ur':
        return model.result.uri ?? '';
    }
  }

  private summaryNode(model: ResultModel): HTMLElement {
    const wrapper = el('div');
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.gap = '12px';

    const fields = model.cbor.ok ? describeFields(model.result.type, model.cbor.node) : null;
    if (fields && fields.length > 0) {
      const table = el('div', 'kv');
      for (const field of fields) {
        const row = el('div', 'kv-row');
        row.append(el('span', 'kv-key', field.label));
        const value = el('span', field.mono ? 'kv-val' : 'kv-val wrap', field.value);
        row.append(value);
        table.append(row);
      }
      wrapper.append(table);
    } else if (!model.cbor.ok) {
      wrapper.append(
        el(
          'p',
          'muted',
          `The payload is not valid CBOR (${model.cbor.error}) — the Hex tab holds the raw bytes.`,
        ),
      );
    } else if (!model.text) {
      wrapper.append(
        el('p', 'muted', 'This UR type has no named fields — open the CBOR tab for the raw structure.'),
      );
    }

    if (model.text) {
      const preview = model.text.slice(0, MAX_PREVIEW_TEXT);
      const block = el('pre', 'code', preview);
      if (model.text.length > MAX_PREVIEW_TEXT) {
        block.append(document.createTextNode('\n… truncated, use the Hex tab for the full value'));
      }
      wrapper.append(block);
    }

    return wrapper;
  }

  private summaryText(model: ResultModel): string {
    const lines = [
      `type: ${model.result.type}`,
      `size: ${model.result.payload.length} bytes`,
      `frames: ${model.result.accepted}`,
      `decoded in: ${formatDuration(model.result.durationMs)}`,
    ];
    if (model.text) lines.push('', model.text.slice(0, MAX_PREVIEW_TEXT));
    return lines.join('\n');
  }

  private buildStats(model: ResultModel): HTMLElement {
    const row = el('div', 'stats');
    const stats: Array<[string, string]> = [
      ['Payload', formatBytes(model.result.payload.length)],
      ['Frames', String(model.result.accepted)],
      ['Time', formatDuration(model.result.durationMs)],
      [
        'Mode',
        model.result.singlePart ? 'single part' : 'multi part',
      ],
    ];
    for (const [label, value] of stats) {
      const cell = el('div', 'stat');
      cell.append(el('span', undefined, label), el('strong', undefined, value));
      row.append(cell);
    }
    return row;
  }

  private buildActions(): HTMLElement {
    const model = this.model;
    if (!model) return el('div');

    const row = el('div', 'actions');

    const copy = el('button', 'btn primary', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      const text = this.tabText(this.activeTab, model);
      if (!text) {
        toast('Nothing to copy in this view', 'warn');
        return;
      }
      const ok = await copyText(text);
      toast(ok ? 'Copied to clipboard' : 'Clipboard is blocked in this context', ok ? 'ok' : 'error');
    });

    const savePayload = el('button', 'btn', 'Save payload');
    savePayload.type = 'button';
    savePayload.title = 'Download the decoded bytes exactly as received';
    savePayload.addEventListener('click', () => {
      saveFile(
        `${model.result.type}${payloadExtension(model.result.type)}`,
        new Uint8Array(model.result.payload),
        'application/octet-stream',
      );
    });

    const saveText = el('button', 'btn ghost', 'Save view');
    saveText.type = 'button';
    saveText.addEventListener('click', () => {
      saveFile(`${model.result.type}-${this.activeTab}.txt`, this.tabText(this.activeTab, model), 'text/plain');
    });

    const again = el('button', 'btn ghost', 'Scan another');
    again.type = 'button';
    again.addEventListener('click', () => this.onReset());

    row.append(copy, savePayload, saveText, again);
    return row;
  }
}
