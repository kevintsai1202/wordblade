// 測試插件：render 時無窮迴圈（模擬逾時的壞插件）。init 正常，所以可先建好再觸發。
(function (g) {
  g.plugin = {
    init() { return { renderer: 'hang-plugin' }; },
    render() { for (;;) { /* 故意卡死 */ } },
    probe() { return {}; },
  };
})(globalThis);
