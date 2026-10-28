// Publish Kit 子頁籤（spec §5.17、§5.12）：Muse Spark 依成片逐字稿寫 3 個標題、說明、重點、章節、標籤（可改、可複製貼到 YouTube）；
// 縮圖用播放頭這一格當底圖——可以直接用，或請 Muse Image 改成縮圖風格（約 30 秒，不畫字）——再由 WordBlade 疊上選中的標題。
// 文字存在專案（Project.publish）；縮圖只放記憶體，匯出 MP4 時兩者都同名寫在影片旁邊（<名>.publish.md、<名>.thumbnail.png）。
import { useEffect, useMemo, useState, type Dispatch } from "react";
import { GatewayClient, GatewayError, loadSettings, saveSettings, type GatewaySettings } from "../ai/gateway";
import { timelineWords } from "../core/captions";
import type { Project } from "../core/model";
import { chaptersToText, parseChapters, youtubeDescription, type PublishKit } from "../publish/kit";
import { generateKit } from "../publish/run";
import { composeThumbnail } from "../publish/thumbnail";
import { captureFramePng } from "./capture";
import type { Action } from "./state";

/** 同意把逐字稿與畫面送給 AI 的紀錄 */
const CONSENT_KEY = "wordblade.consent.publish";

/** 有沒有同意過 */
function hasConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "yes";
  } catch {
    return false;
  }
}

/** 錯誤訊息 */
const message = (e: unknown) => (e instanceof GatewayError || e instanceof Error ? e.message : String(e));

/** 語言選項（auto：依逐字稿判斷） */
const LANGUAGES = [{ id: "auto", label: "Same as the transcript" }, { id: "en", label: "English" }, { id: "zh", label: "繁體中文" }];

/** 縮圖（匯出時寫成 PNG） */
export interface Thumbnail {
  blob: Blob;
  url: string;
}

/** Publish Kit 頁籤 */
export function PublishTab({ project, duration, dispatch, thumbnail, onThumbnail }: {
  project: Project;
  /** 成片長度 */
  duration: number;
  dispatch: Dispatch<Action>;
  thumbnail: Thumbnail | null;
  onThumbnail: (t: Thumbnail | null) => void;
}) {
  const kit = project.publish;
  const words = useMemo(() => timelineWords(project), [project]);
  const [settings, setSettings] = useState<GatewaySettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [language, setLanguage] = useState("auto");
  const [busy, setBusy] = useState<"kit" | "frame" | "ai" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /** 等使用者同意後要做的事 */
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [style, setStyle] = useState("");
  /** 章節文字（編輯中；離開欄位才解析回去） */
  const [chapterDraft, setChapterDraft] = useState(kit ? chaptersToText(kit.chapters) : "");
  useEffect(() => setChapterDraft(kit ? chaptersToText(kit.chapters) : ""), [kit?.chapters]); // eslint-disable-line react-hooks/exhaustive-deps

  const noToken = !settings.token;
  const update = (patch: Partial<PublishKit>) => kit && dispatch({ type: "setPublish", kit: { ...kit, ...patch } });

  /** 需要 AI 的動作：沒同意過先問 */
  const withConsent = (action: () => void) => {
    if (hasConsent()) action();
    else setPending(() => action);
  };
  const acceptConsent = () => {
    try {
      localStorage.setItem(CONSENT_KEY, "yes");
    } catch {
      /* 存不了就只在這次有效 */
    }
    const action = pending;
    setPending(null);
    action?.();
  };

  /** 請 AI 寫發佈包 */
  const writeKit = async () => {
    setBusy("kit");
    setError(null);
    setNotice(null);
    try {
      const result = await generateKit(new GatewayClient(settings), words, duration, language === "auto" ? undefined : language);
      dispatch({ type: "setPublish", kit: result.kit });
      setNotice(result.notice);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  /** 縮圖：播放頭這一格當底圖；ai 時先請 Muse Image 改風格 */
  const makeThumbnail = async (ai: boolean) => {
    setBusy(ai ? "ai" : "frame");
    setError(null);
    try {
      const frame = await captureFramePng();
      if (!frame) throw new Error("The preview isn't ready yet.");
      const base = ai ? await new GatewayClient(settings).thumbnailBase(frame, style.trim()) : frame;
      const bitmap = await createImageBitmap(base);
      const blob = await composeThumbnail(bitmap, kit ? kit.titles[kit.title] ?? "" : "");
      bitmap.close();
      if (thumbnail) URL.revokeObjectURL(thumbnail.url);
      onThumbnail({ blob, url: URL.createObjectURL(blob) });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  /** 複製到剪貼簿 */
  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
    } catch {
      setError("Couldn't copy — select the text and copy it yourself.");
    }
  };

  if (!words.length) return <p className="muted placeholder" data-testid="publish-hint">Transcribe the video first — the publish kit is written from the transcript.</p>;
  return (
    <div className="vibe-tab publish-tab" data-testid="publish-tab">
      <h3 className="section-title">Title, description and chapters</h3>
      <div className="row">
        <label>Language <select data-testid="publish-language" value={language} onChange={(e) => setLanguage(e.target.value)}>
          {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select></label>
        <span className="spacer" />
        <button type="button" className="primary" data-testid="publish-generate" disabled={busy !== null || noToken} title={noToken ? "Set the invite token in AI settings first" : undefined}
          onClick={() => withConsent(() => void writeKit())}>{busy === "kit" ? "Writing…" : kit ? "Write again" : "Write with AI"}</button>
      </div>
      {notice && <p className="muted" data-testid="publish-notice">{notice}</p>}
      {kit && (
        <>
          <fieldset className="publish-titles" data-testid="publish-titles">
            <legend>Title <button type="button" className="link" data-testid="copy-title" onClick={() => void copy("title", kit.titles[kit.title] ?? "")}>{copied === "title" ? "Copied" : "Copy"}</button></legend>
            {kit.titles.map((t, i) => (
              <label key={i} className="publish-title">
                <input type="radio" name="publish-title" checked={kit.title === i} onChange={() => update({ title: i })} />
                <input type="text" value={t} maxLength={100} onChange={(e) => update({ titles: kit.titles.map((x, j) => (j === i ? e.target.value : x)) })} />
              </label>
            ))}
          </fieldset>
          <label className="param-field publish-field"><span>Description <button type="button" className="link" data-testid="copy-description" onClick={() => void copy("description", youtubeDescription(kit))}>{copied === "description" ? "Copied" : "Copy all"}</button></span>
            <textarea data-testid="publish-description" rows={4} value={kit.description} onChange={(e) => update({ description: e.target.value })} />
          </label>
          <label className="param-field publish-field"><span>Highlights (one per line)</span>
            <textarea rows={4} value={kit.highlights.join("\n")} onChange={(e) => update({ highlights: e.target.value.split("\n") })} onBlur={() => update({ highlights: kit.highlights.map((h) => h.trim()).filter(Boolean) })} />
          </label>
          <label className="param-field publish-field"><span>Chapters (0:00 Title, one per line)</span>
            <textarea data-testid="publish-chapters" rows={5} value={chapterDraft} onChange={(e) => setChapterDraft(e.target.value)} onBlur={() => update({ chapters: parseChapters(chapterDraft) })} />
          </label>
          <label className="param-field publish-field"><span>Tags <button type="button" className="link" data-testid="copy-tags" onClick={() => void copy("tags", kit.tags.join(", "))}>{copied === "tags" ? "Copied" : "Copy"}</button></span>
            <input type="text" data-testid="publish-tags" value={kit.tags.join(", ")} onChange={(e) => update({ tags: e.target.value.split(",").map((t) => t.trimStart()) })} onBlur={() => update({ tags: kit.tags.map((t) => t.trim()).filter(Boolean) })} />
          </label>
        </>
      )}

      <h3 className="section-title">Thumbnail</h3>
      <p className="muted">Move the playhead to a good frame. The title{kit ? " you picked" : ""} is drawn on top; the AI only restyles the picture (it can't spell).</p>
      <label className="param-field"><span>AI style (optional)</span><input type="text" data-testid="thumb-style" maxLength={300} placeholder="e.g. bold tech look, blue and orange" value={style} onChange={(e) => setStyle(e.target.value)} /></label>
      <div className="row">
        <button type="button" data-testid="thumb-frame" disabled={busy !== null} onClick={() => void makeThumbnail(false)}>{busy === "frame" ? "Making…" : "Use this frame"}</button>
        <button type="button" data-testid="thumb-ai" disabled={busy !== null || noToken} title={noToken ? "Set the invite token in AI settings first" : "About 30 seconds"} onClick={() => withConsent(() => void makeThumbnail(true))}>{busy === "ai" ? "Restyling… (~30 s)" : "Restyle with AI"}</button>
      </div>
      {thumbnail && <img className="publish-thumb" data-testid="thumb-preview" src={thumbnail.url} alt="Thumbnail preview" />}
      <p className="muted">Export saves {kit ? "<name>.publish.md" : ""}{kit && thumbnail ? " and " : ""}{thumbnail ? "<name>.thumbnail.png" : ""}{kit || thumbnail ? " next to the video." : "the publish kit next to the video once you make one."}</p>
      {error && <p className="error" data-testid="publish-error">{error}</p>}

      {pending && (
        <div className="consent" data-testid="publish-consent">
          <p>The transcript of your edit (for the text) or the current frame (for the AI thumbnail) will be sent to the WordBlade AI service and Meta Muse Spark / Muse Image. Muse Spark runs as the Contributor version: Meta may use what you send to train its models. "Use this frame" works offline and sends nothing.</p>
          <button onClick={acceptConsent}>Agree and continue</button> <button onClick={() => setPending(null)}>Cancel</button>
        </div>
      )}
      <button className="link" onClick={() => setShowSettings((s) => !s)}>{showSettings ? "Hide AI settings" : noToken ? "AI settings (needed for AI)" : "AI settings"}</button>
      {showSettings && (
        <form className="ai-settings" onSubmit={(e) => { e.preventDefault(); saveSettings(settings); setShowSettings(false); }}>
          <label className="param-field"><span>Service URL</span><input type="url" value={settings.url} onChange={(e) => setSettings({ ...settings, url: e.target.value })} /></label>
          <label className="param-field"><span>Invite token</span><input type="password" value={settings.token} autoComplete="off" onChange={(e) => setSettings({ ...settings, token: e.target.value })} /></label>
          <button type="submit">Save</button>
        </form>
      )}
    </div>
  );
}
