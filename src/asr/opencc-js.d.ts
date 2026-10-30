// opencc-js 沒有附型別：只宣告這裡用到的簡轉繁轉換器
declare module "opencc-js/cn2t" {
  /** 建一個轉換器：from 原文地區（cn）、to 目標（tw 字形、twp 再加台灣用語） */
  export function Converter(options: { from: "cn"; to: "tw" | "twp" | "hk" | "t" }): (text: string) => string;
}
