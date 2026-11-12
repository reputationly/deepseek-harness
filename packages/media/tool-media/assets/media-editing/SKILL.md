---
name: media-editing
description: 用 FFmpeg 完成视频与音频剪辑、字幕、混音和拼接。先探测素材，再选用对应工具配方。
---

# 媒体剪辑工作流

先调用 `media_probe` 查看素材时长、容器、视频尺寸与帧率、音频编码和采样信息。可传文件路径，也可传画布媒体节点 id。确认输入后再剪辑；需要顺序拼接视频时一律调用 `merge_videos`。

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

多个视频必须调用 `merge_videos`，按 `video_paths` 顺序传入素材，可用 `scale_mode` 统一分辨率。工具会探测每段视频，统一分辨率和帧率，并为缺失或较短的音轨补静音；不要在 `ffmpeg` 中自行写视频 `concat` 滤镜。
