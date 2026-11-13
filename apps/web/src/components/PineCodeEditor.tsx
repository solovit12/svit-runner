import Editor, { type OnMount } from '@monaco-editor/react';
import '../lib/monaco';

/**
 * The Pine code editor (Monaco, about 2.5 MB). Loaded only on the Strategy page, so the Runs and
 * Accounts pages open without it.
 */
export default function PineCodeEditor({ value, onChange, onMount }: {
  value: string;
  onChange: (value: string) => void;
  onMount: OnMount;
}) {
  return <Editor
    height="100%"
    defaultLanguage="plaintext"
    value={value}
    onChange={(next) => onChange(next || '')}
    onMount={onMount}
    theme="vs-dark"
    loading={<span className="editor-loading">Loading the editor…</span>}
    options={{
      minimap: { enabled: false }, fontSize: 16, lineHeight: 24, fontFamily: 'Cascadia Code, Consolas, monospace',
      scrollBeyondLastLine: false, padding: { top: 14, bottom: 14 }, wordWrap: 'on', automaticLayout: true,
      renderLineHighlight: 'line', overviewRulerBorder: false, hideCursorInOverviewRuler: true,
    }}
  />;
}
