# Create Agent

更新时间：2026-05-21 22:38 +08:00

## 生图错误映射

- `http_error 404` 默认仍表示上游接口路径不存在。
- `file not found, The resource is valid for 2 hours` 表示供应商返回的临时图片资源不可取或已失效，回复为“生图临时资源已失效，请重试或更换提示词”。
- axios 返回 Buffer 错误体时会先解码为 UTF-8，便于日志直接显示真实上游原因。
