import type { Page } from "@playwright/test";

/** 子頁籤屬於哪個大類別（和 src/ui/EditPanel.tsx 的 TAB_GROUPS 一致） */
const GROUP: Record<string, string> = {
  media: "media", transcript: "transcript", style: "transcript",
  vibe: "effects", vibe3d: "effects", zoom: "effects", mask: "effects", audio: "effects", intro: "effects",
  inspector: "inspector", director: "director", export: "export", publish: "export",
};

/** 打開右側面板的某個子頁籤：先點大類別，有子頁籤列再點子頁籤（開發者 2026-10-28 改成大類別＋子頁籤） */
export async function openTab(page: Page, id: string) {
  await page.locator(`[data-group="${GROUP[id]}"]`).click();
  const sub = page.locator(`[data-tab="${id}"]`);
  if (await sub.count()) await sub.click();
}
