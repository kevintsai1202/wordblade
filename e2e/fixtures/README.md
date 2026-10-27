# e2e 測試素材

`import.spec.ts` 用的小檔案，用開發機的 ffmpeg 產生（重產時在這個資料夾執行）：

```powershell
ffmpeg -y -f lavfi -i testsrc2=s=320x180:r=30:d=4 -f lavfi -i "sine=f=440:d=4" -c:v libx264 -pix_fmt yuv420p -g 30 -c:a aac -b:a 64k -shortest -movflags +faststart talk.mp4
ffmpeg -y -f lavfi -i "sine=f=220:d=6" -c:a libmp3lame -b:a 64k music.mp3
ffmpeg -y -f lavfi -i testsrc2=s=128x72:d=1 -frames:v 1 card.png
ffmpeg -y -i talk.mp4 -c copy clip.mkv   # 網頁版不收 MKV，測錯誤訊息用
ffmpeg -y -f lavfi -i "color=c=red@0.5:s=320x180:r=30:d=2,format=rgba" -c:v png alpha.mov   # 半透明紅色，桌面版自我檢查測透明代理檔
ffmpeg -y -f lavfi -i testsrc2=s=320x180:r=30:d=8 -f lavfi -i "aevalsrc='(between(t,0,2)+between(t,3.5,5.5)+between(t,7,8))*0.5*sin(2*PI*440*t)':s=44100:d=8" -c:v libx264 -pix_fmt yuv420p -g 30 -c:a aac -b:a 64k -shortest -movflags +faststart gaps.mp4   # 中間兩段 1.5 秒無聲，清除無聲片段的 e2e 用
```
