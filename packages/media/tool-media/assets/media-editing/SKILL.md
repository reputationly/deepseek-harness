---
name: media-editing
description: 用共享时间线完成成片剪辑、原声、配音、音乐和字幕，预览与导出一致；本地音频编辑和首尾帧优先 media_edit，独立文件加工再用 FFmpeg。
---

# 媒体剪辑工作流

先 `canvas_get` 读取原项目和分集；目标是时间线时再 `timeline_get`。先用 `media_probe` 确认素材的真实时长、尺寸、帧率和音频信息。采用版本、试听版本、时间线引用版本是三件事，不能自动互相替换。

## 项目成片

使用 `timeline_edit` 做排序、裁头尾、原声音量、独立配音、音乐、转场、图片运镜和字幕。每次带当前 timeline revision、directory、episode，片段固定来源 node/version。保留用户手改；发生冲突后重读，只合并请求影响的字段。

字幕的文字来自剧本；独立配音按实测时长和轨道位置确定时间。H3 内嵌对白只有总时长时不能声称逐句对齐，应明确为待审核的时间草稿，允许手动调整。字幕样式也由共享合成器处理，不另用 drawtext 做一个不同的最终效果。

修改后 `timeline_render`，用 `timeline_render_status` 检查当前 revision，等 `ready` 后再播放或 `timeline_export`。排队、渲染、封装不等于完成。导出沿用完整质量预览的合成结果，旧缓存不代表修改已生效。使用 `timeline_history` / `timeline_restore` 前读取当前状态；新素材候选不会自动替换轨道上固定的旧版本。

## 本地素材编辑

有画布版本时优先 `media_edit`，界面和 Agent 共用同一编辑器，不调用云端：

- `audio_edit`：`inMs` / `outMs` 裁剪，线性 `volume`，`fadeInMs` / `fadeOutMs`，均作用于明确的源版本。
- `extract_audio` / `first_frame` / `last_frame`：写明结果 `title`，保存派生素材；最后一帧按解码帧数定位，不用近似尾部时间猜测。
- `refresh_tail`：仅刷新指定已采用源版本的衔接尾帧，不改变采用版本。

请求都包含 `directory`、`episode`、`node`、`version`、`operation`。结果是不可变候选，不自动采用或切换试听。相同请求可复用文件和候选；若附件挂载失败，报告保留的文件路径，重新读取项目后显式重试，不把失败说成已入库。

## 独立文件加工

以下 FFmpeg 配方用于用户明确要求独立文件处理、且上面的项目操作不覆盖的情况；项目成片仍走共享时间线。

`ffmpeg` 的 `args` 是参数数组，不要传输出路径。输入路径可用绝对路径或相对项目目录的路径。将已知来源节点按 `-i` 顺序放在 `input_node_ids` 中；未知来源使用空字符串。输出会自动保存并尝试放入项目画布，抽出的音轨、帧和片段都是新节点，不要再次调用 `canvas_edit` 添加。

## 分离音轨

无损抽取兼容的原音轨：

```json
{"args":["-i","<video>","-vn","-c:a","copy"],"output_type":"audio"}
```

若容器或编码不兼容，转为 AAC：

```json
{"args":["-i","<video>","-vn","-c:a","aac","-b:a","192k"],"output_type":"audio"}
```

## 截取片段

按 1–3 秒截取并重新编码，可获得准确边界：

```json
{"args":["-i","<video>","-ss","1","-to","3","-c:v","libx264","-crf","18","-c:a","aac"],"output_type":"video"}
```

若使用 `-c:v copy`，只能在关键帧附近切割，起止时间可能不精确。先用 `media_probe` 确认原素材时长。

## 缩放

保留宽高比并让输出宽度为 1280：

```json
{"args":["-i","<video>","-vf","scale=1280:-2"],"output_type":"video"}
```

带视频滤镜时工具会自动加入 H.264 重编码参数。

## 抽取一帧

在第 1 秒保存一张 PNG 图片：

```json
{"args":["-i","<video>","-ss","1","-frames:v","1"],"output_type":"image"}
```

## 添加文字

用 `drawtext` 添加单行文字，并用 FFmpeg filter 规则转义文字中的冒号、引号和反斜杠：

```json
{"args":["-i","<video>","-vf","drawtext=text='Preview':x=24:y=24:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.5"],"output_type":"video"}
```

非 ASCII 文字需要已配置且存在的 `fontFile`。`drawtext` 不会把字面量 `\\n` 当作换行；多行内容应使用带真实换行的 `textfile` 或多个 `drawtext` 滤镜。

## 替换音轨

保留第一路视频并使用第二路输入的音轨：

```json
{"args":["-i","<video>","-i","<replacement-audio>","-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-shortest"],"output_type":"video"}
```

## 混音

把第二路背景音乐音量降到 15%，再与第一路原声混合：

```json
{"args":["-i","<video>","-i","<music>","-filter_complex","[1:a]volume=0.15[bg];[0:a][bg]amix=inputs=2:duration=first[mix]","-map","0:v:0","-map","[mix]","-c:v","copy","-c:a","aac"],"output_type":"video"}
```

## 拼接

独立文件的顺序拼接调用 `merge_videos`，按 `video_paths` 顺序传入素材，可用 `scale_mode` 统一分辨率。工具会探测每段视频，统一分辨率和帧率，并为缺失或较短的音轨补静音；不要在 `ffmpeg` 中自行写视频 `concat` 滤镜。需要后续手动编辑的完整项目，使用时间线而不是这条独立文件路线。
