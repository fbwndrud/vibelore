# vibelore user guide

[한국어](README.md) | English

vibelore is a local tool for writing novels with a connected AI and turning existing novels into vertical webtoons.
This document shows how to **start, check the results, and revise and continue**.

If you are new, read [Installation and your first work](GETTING_STARTED.en.md) first. If you already have a work, you can go straight to
[Making a webtoon](WEBTOON.en.md) or the item you need below.

## Using it

| What you want to do | Guide |
|---|---|
| Install and write your first novel | [Getting started](GETTING_STARTED.en.md) |
| Make a novel into a webtoon and fix it | [Making a webtoon](WEBTOON.en.md) |
| Understand what the AI and vibelore each do | [Architecture — from request to storage](ARCHITECTURE.en.md) |
| Check the text and image models and cost paths | [Model settings](MODELS.en.md) |
| Continue stopped work, apply hand edits, back up | [Troubleshooting and backups](TROUBLESHOOTING.en.md) |
| Check where manuscripts and images are sent | [Data and security](../SECURITY.md) |
| Write a work in a language other than Korean | [TOOLS.en.md — Work language and length units](TOOLS.en.md#work-language-and-length-units) |
| Read the README in another language | [한국어](../README.md) · [English](../README.en.md) · [日本語](../README.ja.md) · [Español](../README.es.md) · [Français](../README.fr.md) · [繁體中文](../README.zh-Hant.md) · [ไทย](../README.th.md) · [العربية](../README.ar.md) |

A novel proceeds as settings and plan → draft and review → approval and save.
A webtoon goes existing novel → confirm direction, references and panel count → scene adaptation and English direction → pre-generation check → scene image → visual review.
In normal use you don't need to memorize tool names or internal states; just ask in the chat.

## When integrating directly or investigating a problem

The documents below are detailed references for host AIs, integration developers and contributors.
Internal state names and call examples are material for actual tool integration or problem investigation.

- [MCP tool reference](TOOLS.en.md): arguments and responses, default and advanced tools
- [MCP connection and response contract](MCP.en.md): passing work between the server and the host
- [Webtoon host execution contract](reference/WEBTOON_WORKFLOW.en.md): the default scene path and the image import, review and approval contract
- [Operations and recovery details](OPERATIONS.en.md): execution state and audit records, manual recovery
- [Host verification records](../HOSTS.en.md), [Design principles](PHILOSOPHY.en.md)

## Project information

- [Changes](../CHANGELOG.md)
- [Contributing](../CONTRIBUTING.md)
- [License](../LICENSE) · [Notice](../NOTICE)
