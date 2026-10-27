// 逐字稿頁籤（spec §5.1 改字即剪、§4 改字）：依字幕分段、逐字顯示，播放到的字高亮。
// 點字：播放頭跳到那個字；Shift＋點：選一段；Delete／Backspace：剪掉選的字（cutWords，V1 漣漪＋跨軌規則）；
// 雙擊：就地改字（editWords，字數變了在原本的總時間內重新分配）；Esc：取消選取或編輯。每次剪或改都是一筆可復原的編輯。
import { useMemo, useState, type Dispatch, type KeyboardEvent } from "react";
import { timelineWords, type Caption, type TimelineWord } from "../core/captions";
import type { Project } from "../core/model";
import { formatTimecode, type Action } from "./state";

/** 逐字稿頁籤 */
export function TranscriptTab({ project, captions, playhead, dispatch }: { project: Project; captions: Caption[]; playhead: number; dispatch: Dispatch<Action> }) {
  const words = useMemo(() => timelineWords(project), [project]);
  /** 選取：時間軸上的詞的索引範圍（含頭尾）；anchor 是 Shift 選取的起點 */
  const [selection, setSelection] = useState<{ anchor: number; from: number; to: number } | null>(null);
  /** 正在就地改字的範圍與草稿 */
  const [editing, setEditing] = useState<{ from: number; to: number; draft: string } | null>(null);

  /** 每段字幕的詞（依時間落在字幕範圍內；同一個詞 id 出現兩次時也分得開） */
  const groups = useMemo(() => {
    let k = 0;
    return captions.map((c) => {
      const list: { word: TimelineWord; index: number }[] = [];
      while (k < words.length && words[k].start < c.start - 0.01) k++;
      while (k < words.length && words[k].start < c.end) list.push({ word: words[k], index: k++ });
      return { caption: c, words: list };
    });
  }, [captions, words]);

  const selected = (i: number) => !!selection && i >= selection.from && i <= selection.to;
  /** 選取範圍的詞 id（不重複） */
  const selectedIds = () => (selection ? [...new Set(words.slice(selection.from, selection.to + 1).map((w) => w.id))] : []);

  /** 點字：跳播放頭；Shift 時延伸選取 */
  const onClickWord = (i: number, shift: boolean) => {
    if (shift && selection) setSelection({ anchor: selection.anchor, from: Math.min(selection.anchor, i), to: Math.max(selection.anchor, i) });
    else setSelection({ anchor: i, from: i, to: i });
    dispatch({ type: "seek", time: words[i].start });
  };

  /** 鍵盤：Delete／Backspace 剪掉選取的字（攔下來，不讓全域的「刪片段」熱鍵處理）；Esc 取消 */
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (editing) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selection) {
      e.preventDefault();
      dispatch({ type: "commit", edits: [{ kind: "cutWords", wordIds: selectedIds() }] });
      setSelection(null);
    } else if (e.key === "Escape") {
      setSelection(null);
    }
  };

  /** 雙擊：改選取的字（雙擊的字不在選取裡就只改那一個字） */
  const onDoubleClick = (i: number) => {
    const range = selected(i) && selection ? { from: selection.from, to: selection.to } : { from: i, to: i };
    setEditing({ ...range, draft: words.slice(range.from, range.to + 1).map((w) => w.text).join(" ") });
  };

  /** 送出改字 */
  const commitEdit = () => {
    if (!editing) return;
    const ids = [...new Set(words.slice(editing.from, editing.to + 1).map((w) => w.id))];
    const before = words.slice(editing.from, editing.to + 1).map((w) => w.text).join(" ");
    if (editing.draft.trim() && editing.draft.trim() !== before) dispatch({ type: "commit", edits: [{ kind: "editWords", wordIds: ids, text: editing.draft }] });
    setEditing(null);
    setSelection(null);
  };

  return (
    <ol className="transcript" tabIndex={0} onKeyDown={onKeyDown} data-testid="transcript">
      {groups.map(({ caption, words: list }) => (
        <li key={`${caption.id}@${caption.start}`} className={playhead >= caption.start && playhead < caption.end ? "active" : ""}>
          <span className="timecode">{formatTimecode(caption.start).slice(3)}</span>
          <span className="caption-text">
            {list.map(({ word, index }, n) => {
              // 改字中：選取範圍的第一個字換成輸入框，其他的字不顯示
              if (editing && index >= editing.from && index <= editing.to) {
                if (index !== editing.from) return null;
                return (
                  <input
                    key={`edit-${index}`} className="word-edit" data-testid="word-edit" autoFocus value={editing.draft}
                    onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
                      if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                    }}
                    onBlur={commitEdit}
                  />
                );
              }
              const active = playhead >= word.start && playhead < word.end;
              return (
                <span key={`${word.clipId ?? ""}:${word.id}`}>
                  {n > 0 && " "}
                  <span
                    className={`word${active ? " playing" : ""}${selected(index) ? " selected" : ""}`}
                    data-word-id={word.id}
                    onClick={(e) => onClickWord(index, e.shiftKey)}
                    onDoubleClick={() => onDoubleClick(index)}
                  >{word.text}</span>
                </span>
              );
            })}
          </span>
        </li>
      ))}
    </ol>
  );
}
