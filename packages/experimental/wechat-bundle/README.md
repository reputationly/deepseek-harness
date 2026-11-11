---
description: "Bind a private WeChat chat to a local DSH agent through Tencent iLink."
kind: "plugin"
---

# @deepseek-ai/dsh-wechat-bundle

English | [中文](README.zh.md)

## Summary

The experimental WeChat ClawBot bundle connects a private WeChat chat to a local DSH agent through Tencent iLink. Bind the account from **Settings → WeChat**, then message the ClawBot directly. The selected DSH workspace and conversation are persisted locally and remain available in the desktop application.

The bundle composes the Host integration and its Client settings card. It does not include group-chat support.

## Use this bundle

Install or enable **WeChat ClawBot** from the plugin manager. Open **Settings → WeChat**, select **Add WeChat**, and scan the displayed QR code with the account that owns the private chat.

Keep the desktop application open and prevent the computer from sleeping while using WeChat. Use `/help` in the chat to see the available commands.

## Known Limitations and Deferred Work

- Experimental integration; availability and protocol behavior depend on Tencent iLink.
- Only direct messages from the linked owner account are processed. Group messages are ignored.
- The local host must remain running to receive messages.
