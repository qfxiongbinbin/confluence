/**
 * 必须作为 CLI 的第一个 import（ESM 按源码顺序求值，先于 node:sqlite 加载）。
 *
 * node:sqlite 等实验性 API 会通过 process.emitWarning 发出 ExperimentalWarning，
 * 默认行为是直接写 stderr——在 TUI 全屏模式下会把警告文本砸进界面，
 * 破坏输入区布局。
 *
 * 注意：Node 的默认警告打印器本身就是挂在 'warning' 事件上的内部监听器，
 * 仅追加自己的监听器拦不住它，必须先移除再注册。我们是第一个 import，
 * 此时没有其他业务监听器，removeAllListeners 只会移除 Node 内置打印器。
 */
process.removeAllListeners('warning');
process.on('warning', (warning: Error) => {
  if (warning.name === 'ExperimentalWarning') return;
  console.error(`(node:${process.pid}) ${warning.name}: ${warning.message}`);
});
