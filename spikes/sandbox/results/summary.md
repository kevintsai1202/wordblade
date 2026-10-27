| 項目 | chromium-headed | msedge-headed | chromium-headless |
|---|---|---|---|
| 瀏覽器版本 | 156.0.8078.4 | 156.0.4314.42 | 156.0.8078.4 |
| 主頁 WebGL renderer | ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11) | ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11) | ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver) |
| Worker WebGL renderer | ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11) | ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11) | ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver) |
| fatal/crash | 無 | 無 | 無 |
| 啟動 nonce/spec | 通過 boot 293ms，像素錯 0 | 通過 boot 223ms，像素錯 0 | 通過 boot 163ms，像素錯 0 |
| 啟動 nonce/hardened | 通過 boot 193ms，像素錯 0 | 通過 boot 185ms，像素錯 0 | 通過 boot 127ms，像素錯 0 |
| 啟動 hash/spec | 通過 boot 161ms，像素錯 0 | 通過 boot 135ms，像素錯 0 | 通過 boot 121ms，像素錯 0 |
| 啟動 blob/spec | 失敗：iframe 3 秒內沒有 boot（CSP 擋掉啟動腳本？） | 失敗：iframe 3 秒內沒有 boot（CSP 擋掉啟動腳本？） | 失敗：iframe 3 秒內沒有 boot（CSP 擋掉啟動腳本？） |
| inline nonce script 內嵌 | true | true | true |
| directSmallReadback.sendToWorkerAndBack mean/p95/max ms | 2.608 / 3.8 / 11.6 | 2.631 / 3.3 / 4.5 | 39.145 / 57.3 / 91.4 |
| directSmallReadback.readback mean/p95/max ms | 15.568 / 20.5 / 23.5 | 17.091 / 20.4 / 27.8 | 19.758 / 30.5 / 58.7 |
| directSmallReadback.roundTripTotalExclCreate mean/p95/max ms | 18.24 / 23.8 / 27.4 | 19.801 / 23.4 / 30.5 | 60.356 / 94.7 / 127.3 |
| directSmallReadback.perFrameTotal mean/p95/max ms | 18.408 / 24.1 / 27.7 | 19.975 / 23.6 / 30.7 | 62.169 / 96.9 / 129.9 |
| directSmallReadback.createImageBitmap mean/p95/max ms | 0.168 / 0.3 / 1 | 0.174 / 0.3 / 0.5 | 1.813 / 2.4 / 3.4 |
| directSmallReadback.mainUploadDraw mean/p95/max ms | 0.064 / 0.1 / 0.2 | 0.079 / 0.2 / 0.3 | 1.453 / 2.1 / 3.4 |
| directSmallReadback.像素不符格數 | 0 | 0 | 0 |
| directFullReadback.sendToWorkerAndBack mean/p95/max ms | 2.367 / 2.8 / 17.2 | 4.632 / 10.4 / 66.6 | 36.368 / 44.4 / 77.9 |
| directFullReadback.readback mean/p95/max ms | 21.678 / 29.6 / 34.7 | 30.566 / 38.5 / 47 | 24.097 / 30.2 / 34.2 |
| directFullReadback.roundTripTotalExclCreate mean/p95/max ms | 24.105 / 32.1 / 37.6 | 35.296 / 45.5 / 91.9 | 61.784 / 75.3 / 111.3 |
| directFullReadback.perFrameTotal mean/p95/max ms | 24.271 / 32.3 / 37.7 | 35.532 / 45.7 / 92.1 | 63.263 / 77.6 / 113.9 |
| directFullReadback.createImageBitmap mean/p95/max ms | 0.166 / 0.3 / 0.5 | 0.236 / 0.4 / 0.6 | 1.479 / 2.2 / 3.7 |
| directFullReadback.mainUploadDraw mean/p95/max ms | 0.06 / 0.1 / 0.2 | 0.098 / 0.2 / 0.4 | 1.319 / 2 / 2.3 |
| directFullReadback.像素不符格數 | 0 | 0 | 0 |
| relayFullReadback.sendToWorkerAndBack mean/p95/max ms | 3.679 / 5.7 / 14.5 | 5.235 / 12.2 / 40.7 | 43.633 / 56.3 / 63.3 |
| relayFullReadback.readback mean/p95/max ms | 27.626 / 33.5 / 46.2 | 30.425 / 39.1 / 69.6 | 24.655 / 30.9 / 39.3 |
| relayFullReadback.roundTripTotalExclCreate mean/p95/max ms | 31.392 / 38.8 / 49.3 | 35.759 / 46.2 / 80.1 | 69.582 / 88.1 / 101.2 |
| relayFullReadback.perFrameTotal mean/p95/max ms | 31.578 / 39.1 / 49.5 | 35.994 / 46.5 / 80.4 | 70.946 / 89.6 / 103.2 |
| relayFullReadback.createImageBitmap mean/p95/max ms | 0.186 / 0.3 / 0.4 | 0.234 / 0.4 / 0.5 | 1.364 / 2 / 2.8 |
| relayFullReadback.mainUploadDraw mean/p95/max ms | 0.087 / 0.2 / 0.3 | 0.099 / 0.2 / 0.9 | 1.294 / 2 / 2.5 |
| relayFullReadback.像素不符格數 | 0 | 0 | 0 |
| 決定性（同格兩次雜湊相等） | true | true | true |
| gl worker setup / scriptLoad / init ms | 34 / 18 / 16 | 35 / 15 / 20 | 25 / 13 / 12 |
| three 啟動 setup ms（三次） | 78(load 50+init 28), 81(load 55+init 27), 332(load 298+init 34) | 386(load 304+init 82), 138(load 83+init 54), 175(load 107+init 68) | 134(load 88+init 46), 115(load 74+init 41), 98(load 64+init 35) |
| three 版本／webgl2 | 186/true | 186/true | 186/true |
| three 60 格 mean/p95 ms、像素不符 | 16.432/18.1、0 | 17.013/19.5、0 | 71.823/78.5、0 |
| 反向 spec/worker 失敗項 | 13 項，失敗：無 | 13 項，失敗：無 | 13 項，失敗：無 |
| 反向 spec/iframeMain 失敗項 | 12 項，失敗：無 | 12 項，失敗：無 | 12 項，失敗：無 |
| RTC spec lockdown 後 udp 封包 | 0 | 0 | 0 |
| RTC spec 未 lockdown udp 封包 | 3 | 3 | 3 |
| parent 存取 spec | parentDocument:擋 parentBody:擋 parentSecretVar:擋 parentLocalStorage:擋 topLocation:擋 ownCookie:擋 ownLocalStorage:擋 ownSessionStorage:擋 indexedDB:擋 origin:擋 | parentDocument:擋 parentBody:擋 parentSecretVar:擋 parentLocalStorage:擋 topLocation:擋 ownCookie:擋 ownLocalStorage:擋 ownSessionStorage:擋 indexedDB:擋 origin:擋 | parentDocument:擋 parentBody:擋 parentSecretVar:擋 parentLocalStorage:擋 topLocation:擋 ownCookie:擋 ownLocalStorage:擋 ownSessionStorage:擋 indexedDB:擋 origin:擋 |
| 反向 hardened/worker 失敗項 | 13 項，失敗：無 | 13 項，失敗：無 | 13 項，失敗：無 |
| 反向 hardened/iframeMain 失敗項 | 12 項，失敗：無 | 12 項，失敗：無 | 12 項，失敗：無 |
| RTC hardened lockdown 後 udp 封包 | 0 | 0 | 0 |
| RTC hardened 未 lockdown udp 封包 | 3 | 3 | 3 |
| parent 存取 hardened | parentDocument:擋 parentBody:擋 parentSecretVar:擋 parentLocalStorage:擋 topLocation:擋 ownCookie:擋 ownLocalStorage:擋 ownSessionStorage:擋 indexedDB:擋 origin:擋 | parentDocument:擋 parentBody:擋 parentSecretVar:擋 parentLocalStorage:擋 topLocation:擋 ownCookie:擋 ownLocalStorage:擋 ownSessionStorage:擋 indexedDB:擋 origin:擋 | parentDocument:擋 parentBody:擋 parentSecretVar:擋 parentLocalStorage:擋 topLocation:擋 ownCookie:擋 ownLocalStorage:擋 ownSessionStorage:擋 indexedDB:擋 origin:擋 |
| 對照組 udp 封包 | 3 | 3 | 3 |
| 對照組(主頁) 到達誘餌 | {"fetch":1,"xhr":1,"websocket":1,"eventsource":1,"dynamicImport":1,"importScriptsExternal":0,"sendBeacon":1,"imgBeacon":1,"windowOpen":1} | {"fetch":1,"xhr":1,"websocket":1,"eventsource":1,"dynamicImport":1,"importScriptsExternal":0,"sendBeacon":1,"imgBeacon":1,"windowOpen":1} | {"fetch":1,"xhr":1,"websocket":1,"eventsource":1,"dynamicImport":1,"importScriptsExternal":0,"sendBeacon":1,"imgBeacon":1,"windowOpen":1} |
| 對照組(Worker) 到達誘餌 | {"fetch":1,"xhr":1,"websocket":1,"eventsource":1,"dynamicImport":1,"importScriptsExternal":1,"sendBeacon":0,"imgBeacon":0,"windowOpen":0} | {"fetch":1,"xhr":1,"websocket":1,"eventsource":1,"dynamicImport":1,"importScriptsExternal":1,"sendBeacon":0,"imgBeacon":0,"windowOpen":0} | {"fetch":1,"xhr":1,"websocket":1,"eventsource":1,"dynamicImport":1,"importScriptsExternal":1,"sendBeacon":0,"imgBeacon":0,"windowOpen":0} |
| Worker 內 blob importScripts（父頁放行 blob 時） | true | true | true |
| 導航外洩 spec：誘餌收到 | 0 | 0 | 0 |
| 導航外洩 hardened：誘餌收到 | 0 | 0 | 0 |
| 導航外洩 spec+parentFrameSrcOpen：誘餌收到 | 1 | 1 | 1 |
| 時間 Date.now／new Date／perf.now／ctor | true/true/true/true | true/true/true/true | true/true/true/true |
| 亂數同種子序列相同 | true | true | true |
| Intl 無參數 format | 1/1/26, 12:00:02 AM | 1/1/26, 12:00:02 AM | 1/1/26, 12:00:02 AM |
| 未覆蓋：perf.mark／event.timeStamp | 331/330 | 216/216 | 152/152 |
| 逾時第1輪 預算/偵測/kill/重建/首格 ms、舊 worker 已消失 | 100/117/1.3/126/24、true、像素true | 100/101/0.9/44/28、true、像素true | 100/106/0.2/17/70、true、像素true |
| 逾時第2輪 預算/偵測/kill/重建/首格 ms、舊 worker 已消失 | 100/113/0.8/839/51、true、像素true | 100/105/0.7/36/35、true、像素true | 100/115/0.2/20/72、true、像素true |
| 逾時第3輪 預算/偵測/kill/重建/首格 ms、舊 worker 已消失 | 100/111/1.4/239/66、true、像素true | 100/111/1.2/50/39、true、像素true | 100/106/0.2/16/66、true、像素true |
| 逾時第4輪 預算/偵測/kill/重建/首格 ms、舊 worker 已消失 | 30/32/1.2/67/59、true、像素true | 30/31/0.9/38/30、true、像素true | 30/32/0.2/16/67、true、像素true |
| 逾時第5輪 預算/偵測/kill/重建/首格 ms、舊 worker 已消失 | 30/31/1/99/59、true、像素true | 30/32/0.6/42/25、true、像素true | 30/32/0.2/27/86、true、像素true |
| 逾時期間主頁心跳最大間隔 ms | 90 | 51 | 31 |
| 退路：iframe 主執行緒無窮迴圈 主頁被卡？ | false | false | true |
| 退路：心跳最大間隔 ms | 21 | 22 | undefined |
| 退路：移除並重建成功 | {"removeMs":0.3,"rebuildOk":true,"totalMs":257} | {"removeMs":0.4,"rebuildOk":true,"totalMs":220} | "逾時 4000ms：() => window.t.heartbeat()" |
| 退路：CDP target 類型 | worker,browser_ui,browser_ui,page,iframe,page,iframe,browser_ui,browser_ui | worker,page,iframe,page,iframe |  |
| 建/殺 Worker×40：每次啟動 mean/p95/max ms、最後像素不符、錯誤數 | 56.54/79/106.8、0、0 | 42.905/54.6/59.3、0、0 | 46.342/62/65.2、0、0 |
