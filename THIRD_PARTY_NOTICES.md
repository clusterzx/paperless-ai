# Third-Party Notices
 
Paperless-AI is licensed under the [MIT License](LICENSE). It is built on, ships with and downloads open-source software by others. This file lists that software together with its licenses and copyright notices, as those licenses require.
 
Applies to Paperless-AI **4.x.x**: the Docker images `clusterzx/paperless-ai:latest` (CPU) and `clusterzx/paperless-ai:latest-cuda` (NVIDIA GPU) and builds from this repository. The package lists were generated from `package-lock.json` the same way the Dockerfile installs them (`npm prune --omit=dev`) and from the modules Vite bundles into the web interface.
 
## Contents
 
1. [Overview](#1-overview)
2. [OCR: PaddleOCR](#2-ocr-paddleocr)
3. [Server components in the image](#3-server-components-in-the-image)
4. [Native libraries in the image](#4-native-libraries-in-the-image)
5. [Web interface](#5-web-interface)
6. [Base images](#6-base-images)
7. [Downloaded at runtime, not part of the image](#7-downloaded-at-runtime-not-part-of-the-image)
8. [Trademarks](#8-trademarks)
9. [License texts](#9-license-texts)
## 1. Overview
 
| Component | Where | In the image | License |
|---|---|---|---|
| PaddleOCR models (PP-OCRv6, PP-OCRv5, PP-LCNet) | data directory, downloaded on first use | no | Apache-2.0 |
| ONNX Runtime | `node_modules/onnxruntime-node` | yes | MIT, with third-party notices |
| sharp with libvips | `node_modules/sharp`, `node_modules/@img/*` | yes | Apache-2.0, libvips LGPL-3.0-or-later |
| PDFium (WebAssembly) | `node_modules/@hyzyla/pdfium` | yes | BSD-3-Clause and Apache-2.0 |
| SQLite | `node_modules/better-sqlite3` | yes | Public domain |
| Transformers.js | `node_modules/@huggingface/transformers` | yes | Apache-2.0 |
| All Node.js packages (176) | `node_modules` | yes | [Section 3](#3-server-components-in-the-image) |
| Web interface: bundled libraries and Geist fonts (13 packages) | `dist/public` | yes | [Section 5](#5-web-interface) |
| Local embedding model (multilingual-e5-small) | downloaded on first use | no | MIT |
| LibreOffice (WebAssembly), Office converter | downloaded on first use | no | MPL-2.0 |
 
## 2. OCR: PaddleOCR
 
Paperless-AI uses the text detection, text recognition and orientation models of [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR), Copyright (c) PaddlePaddle Authors, licensed under the [Apache License 2.0](#apache-license-20).
 
- **Models:** the official ONNX exports that PaddlePaddle publishes on Hugging Face. Paperless-AI downloads them on first use, pinned to a fixed revision, into its data directory. They are not part of this repository or the Docker image.
- **Inference:** ONNX Runtime ([section 4.2](#42-onnx-runtime)). The PaddlePaddle framework is not used.
- **Pre- and post-processing** (image preparation, DB text detection post-processing, CTC decoding) is an independent TypeScript implementation that follows the PaddleOCR pipeline. It contains no PaddleOCR source code.
| Model | Hugging Face repository | Revision | License |
|---|---|---|---|
| PP-OCRv6 tiny – text detection | [PaddlePaddle/PP-OCRv6_tiny_det_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx) | `2ba1506c0380` | Apache-2.0 |
| PP-OCRv6 tiny – text recognition | [PaddlePaddle/PP-OCRv6_tiny_rec_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx) | `2612ab37152a` | Apache-2.0 |
| PP-OCRv6 small – text detection | [PaddlePaddle/PP-OCRv6_small_det_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx) | `28fe5895c24f` | Apache-2.0 |
| PP-OCRv6 small – text recognition | [PaddlePaddle/PP-OCRv6_small_rec_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx) | `b8f84f0b80c5` | Apache-2.0 |
| PP-OCRv6 medium – text detection | [PaddlePaddle/PP-OCRv6_medium_det_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_det_onnx) | `61323801669c` | Apache-2.0 |
| PP-OCRv6 medium – text recognition | [PaddlePaddle/PP-OCRv6_medium_rec_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec_onnx) | `50c7eacafc52` | Apache-2.0 |
| PP-OCRv5 mobile – text detection | [PaddlePaddle/PP-OCRv5_mobile_det_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx) | `e6f4fa85f00e` | Apache-2.0 |
| PP-OCRv5 server – text detection | [PaddlePaddle/PP-OCRv5_server_det_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv5_server_det_onnx) | `dcf248c4dcc0` | Apache-2.0 |
| PP-OCRv5 mobile – recognition (multilingual) | [PaddlePaddle/PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx) | `ed152b8b495f` | Apache-2.0 |
| PP-OCRv5 mobile – recognition (Latin) | [PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx) | `89d3a50e2c27` | Apache-2.0 |
| PP-OCRv5 mobile – recognition (English) | [PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx) | `3fafbc3b5dcf` | Apache-2.0 |
| PP-OCRv5 mobile – recognition (Cyrillic) | [PaddlePaddle/cyrillic_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/cyrillic_PP-OCRv5_mobile_rec_onnx) | `2cef88145434` | Apache-2.0 |
| PP-OCRv5 mobile – recognition (East Slavic) | [PaddlePaddle/eslav_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/eslav_PP-OCRv5_mobile_rec_onnx) | `9a32171fc571` | Apache-2.0 |
| PP-OCRv5 mobile – recognition (Greek) | [PaddlePaddle/el_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/el_PP-OCRv5_mobile_rec_onnx) | `8152b89d2ee0` | Apache-2.0 |
| PP-OCRv5 mobile – recognition (Arabic) | [PaddlePaddle/arabic_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/arabic_PP-OCRv5_mobile_rec_onnx) | `14aaedcd7582` | Apache-2.0 |
| PP-OCRv5 mobile – recognition (Devanagari) | [PaddlePaddle/devanagari_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/devanagari_PP-OCRv5_mobile_rec_onnx) | `251aec19e367` | Apache-2.0 |
| PP-OCRv5 mobile – recognition (Korean) | [PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx) | `5c6f574b8e22` | Apache-2.0 |
| PP-OCRv5 mobile – recognition (Thai) | [PaddlePaddle/th_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/th_PP-OCRv5_mobile_rec_onnx) | `1d4adbbafb10` | Apache-2.0 |
| PP-OCRv5 mobile – recognition (Tamil) | [PaddlePaddle/ta_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/ta_PP-OCRv5_mobile_rec_onnx) | `0db89798af0d` | Apache-2.0 |
| PP-OCRv5 mobile – recognition (Telugu) | [PaddlePaddle/te_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/te_PP-OCRv5_mobile_rec_onnx) | `f1197c834302` | Apache-2.0 |
| PP-LCNet x0.25 – text line orientation | [PaddlePaddle/PP-LCNet_x0_25_textline_ori_onnx](https://huggingface.co/PaddlePaddle/PP-LCNet_x0_25_textline_ori_onnx) | `aea1f18d9733` | Apache-2.0 |
| PP-LCNet x1.0 – page orientation | [PaddlePaddle/PP-LCNet_x1_0_doc_ori_onnx](https://huggingface.co/PaddlePaddle/PP-LCNet_x1_0_doc_ori_onnx) | `7330ab703912` | Apache-2.0 |
 
## 3. Server components in the image
 
The image contains the production dependencies of Paperless-AI for `linux/amd64` or `linux/arm64`. The arm64 image contains `@img/sharp-linux-arm64` and `@img/sharp-libvips-linux-arm64` instead of the `-x64` packages, with the same versions and licenses. Where a package offers a choice of licenses, the table shows the one Paperless-AI uses it under. The column **Text** links to the full license text in [section 9](#9-license-texts).
 
| Package | Version | License | Copyright | Text |
|---|---|---|---|---|
| [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) | 0.131.0 | MIT | Copyright 2023 Anthropic, PBC. | [L19](#l19) |
| [@babel/runtime](https://github.com/babel/babel) | 7.29.7 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors | [L19](#l19) |
| [@emnapi/runtime](https://github.com/toyobayashi/emnapi) | 1.11.3 | MIT | Copyright (c) 2021-present Toyobayashi | [L19](#l19) |
| [@fastify/accept-negotiator](https://github.com/fastify/accept-negotiator) | 2.1.0 | MIT | Copyright (c) 2022-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [@fastify/ajv-compiler](https://github.com/fastify/ajv-compiler) | 4.0.6 | MIT | Copyright (c) 2022-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [@fastify/busboy](https://github.com/fastify/busboy) | 3.2.6 | MIT | Copyright Brian White. All rights reserved.<br>Copyright (c) 2021-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [@fastify/cookie](https://github.com/fastify/fastify-cookie) | 11.1.2 | MIT | Copyright (c) 2017-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [@fastify/deepmerge](https://github.com/fastify/deepmerge) | 3.2.4 | MIT | Copyright (c) 2022-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [@fastify/error](https://github.com/fastify/fastify-error) | 4.2.0 | MIT | Copyright (c) 2020 Fastify | [L19](#l19) |
| [@fastify/fast-json-stringify-compiler](https://github.com/fastify/fast-json-stringify-compiler) | 5.1.0 | MIT | Copyright (c) 2022-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [@fastify/forwarded](https://github.com/fastify/forwarded) | 3.0.2 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson<br>Copyright (c) 2021-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [@fastify/merge-json-schemas](https://github.com/fastify/merge-json-schemas) | 0.2.1 | MIT | Copyright (c) 2024 Fastify | [L19](#l19) |
| [@fastify/multipart](https://github.com/fastify/fastify-multipart) | 10.1.9 | MIT | Copyright (c) 2017-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [@fastify/proxy-addr](https://github.com/fastify/proxy-addr) | 5.1.1 | MIT | Copyright (c) 2014-2016 Douglas Christopher Wilson<br>Copyright (c) 2021-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [@fastify/rate-limit](https://github.com/fastify/fastify-rate-limit) | 11.2.0 | MIT | Copyright (c) 2018-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [@fastify/send](https://github.com/fastify/send) | 4.1.1 | MIT | Copyright (c) 2012 TJ Holowaychuk<br>Copyright (c) 2014-2022 Douglas Christopher Wilson<br>Copyright (c) 2023-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [@fastify/static](https://github.com/fastify/fastify-static) | 10.1.5 | MIT | Copyright (c) 2017-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [@fastify/swagger](https://github.com/fastify/fastify-swagger) | 9.9.1 | MIT | Copyright (c) 2017-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [@fastify/swagger-ui](https://github.com/fastify/fastify-swagger-ui) | 6.1.1 | MIT | Copyright (c) 2022-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [@huggingface/jinja](https://github.com/huggingface/huggingface.js) | 0.5.10 | MIT | Copyright (c) 2023 Hugging Face | [L19](#l19) |
| [@huggingface/tokenizers](https://github.com/huggingface/tokenizers.js) | 0.2.0 | Apache-2.0 | Author: Hugging Face (no copyright notice in the package) | [L02](#l02) |
| [@huggingface/transformers](https://github.com/huggingface/transformers.js) | 4.3.0 | Apache-2.0 | Author: Hugging Face (no copyright notice in the package) | [L02](#l02) |
| [@hyzyla/pdfium](https://github.com/hyzyla/pdfium) | 3.0.0 | MIT | Copyright (c) 2012-2023 Scott Chacon and others | [L19](#l19) |
| [@img/colour](https://github.com/lovell/colour) | 1.1.0 | MIT | Copyright (c) 2012 Heather Arthur<br>Copyright (c) 2011-2016 Heather Arthur &lt;fayearthur@gmail.com&gt;.<br>Copyright (c) 2016-2021 Josh Junon &lt;josh@junon.me&gt;.<br>Copyright (c) 2011 Heather Arthur &lt;fayearthur@gmail.com&gt;<br>Copyright (c) 2015 Dmitry Ivanov | [L22](#l22) |
| [@img/sharp-libvips-linux-x64](https://github.com/lovell/sharp-libvips) | 1.3.4 | LGPL-3.0-or-later | libvips: Copyright the libvips authors (https://github.com/libvips/libvips)<br>Packaging: Lovell Fuller | [LGPL-3.0](#gnu-lesser-general-public-license-v3) |
| [@img/sharp-linux-x64](https://github.com/lovell/sharp) | 0.35.5 | Apache-2.0 | Copyright 2013 Lovell Fuller and others | [L03](#l03) |
| [@lukeed/ms](https://github.com/lukeed/ms) | 2.0.2 | MIT | Copyright (c) Luke Edwards &lt;luke.edwards05@gmail.com&gt; (lukeed.com) | [L19](#l19) |
| [@pinojs/redact](https://github.com/pinojs/redact) | 0.4.0 | MIT | Copyright (c) 2025 pinojs contributors | [L19](#l19) |
| [@protobufjs/aspromise](https://github.com/dcodeIO/protobuf.js) | 1.1.2 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. | [L08](#l08) |
| [@protobufjs/base64](https://github.com/dcodeIO/protobuf.js) | 1.1.2 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. | [L08](#l08) |
| [@protobufjs/codegen](https://github.com/dcodeIO/protobuf.js) | 2.0.5 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. | [L08](#l08) |
| [@protobufjs/eventemitter](https://github.com/dcodeIO/protobuf.js) | 1.1.1 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. | [L08](#l08) |
| [@protobufjs/fetch](https://github.com/dcodeIO/protobuf.js) | 1.1.1 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. | [L08](#l08) |
| [@protobufjs/float](https://github.com/dcodeIO/protobuf.js) | 1.0.2 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. | [L08](#l08) |
| [@protobufjs/path](https://github.com/dcodeIO/protobuf.js) | 1.1.2 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. | [L08](#l08) |
| [@protobufjs/pool](https://github.com/dcodeIO/protobuf.js) | 1.1.0 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. | [L08](#l08) |
| [@protobufjs/utf8](https://github.com/protobufjs/protobuf.js) | 1.1.2 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. | [L08](#l08) |
| [@selderee/plugin-htmlparser2](https://github.com/mxxii/selderee) | 0.12.0 | MIT | Copyright (c) 2021-2026 KillyMXI &lt;killy@mxii.eu.org&gt; | [L19](#l19) |
| [@stablelib/base64](https://github.com/StableLib/stablelib) | 1.0.1 | MIT | Copyright (C) 2016 Dmitry Chestnykh | [L23](#l23) |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 22.20.4 | MIT | Copyright (c) Microsoft Corporation. | [L24](#l24) |
| [@zone-eu/mailsplit](https://github.com/zone-eu/mailsplit) | 5.4.30 | MIT (chosen from MIT OR EUPL-1.1+) | Copyright (c) 2011-2019, 2024 Andris Reinman and Zone Media OÜ | [L19](#l19) |
| [abstract-logging](https://github.com/jsumners/abstract-logging) | 2.0.1 | MIT | Author: James Sumners (no copyright notice in the package) | [L19](#l19) |
| [adm-zip](https://github.com/cthackers/adm-zip) | 0.6.1 | MIT | Copyright (c) 2012 Another-D-Mention Software and other contributors | [L19](#l19) |
| [ajv](https://github.com/ajv-validator/ajv) | 8.20.0 | MIT | Copyright (c) 2015-2021 Evgeny Poberezkin | [L19](#l19) |
| [ajv-formats](https://github.com/ajv-validator/ajv-formats) | 3.0.1 | MIT | Copyright (c) 2020 Evgeny Poberezkin | [L19](#l19) |
| [atomic-sleep](https://github.com/davidmarkclements/atomic-sleep) | 1.0.0 | MIT | Copyright (c) 2020 David Mark Clements | [L19](#l19) |
| [avvio](https://github.com/fastify/avvio) | 9.3.0 | MIT | Copyright (c) 2016-2020 Matteo Collina<br>Copyright (c) 2020-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [balanced-match](https://github.com/juliangruber/balanced-match) | 4.0.4 | MIT | Original code Copyright Julian Gruber &lt;julian@juliangruber.com&gt;<br>Port to TypeScript Copyright Isaac Z. Schlueter &lt;i@izs.me&gt; | [L19](#l19) |
| [bcryptjs](https://github.com/dcodeIO/bcrypt.js) | 3.0.3 | BSD-3-Clause | Copyright (c) 2012 Nevins Bartolomeo &lt;nevins.bartolomeo@gmail.com&gt;<br>Copyright (c) 2012 Shane Girish &lt;shaneGirish@gmail.com&gt;<br>Copyright (c) 2025 Daniel Wirtz &lt;dcode@dcode.io&gt; | [L10](#l10) |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | 13.0.3 | MIT | Copyright (c) 2017 Joshua Wise | [L19](#l19) |
| [brace-expansion](https://github.com/juliangruber/brace-expansion) | 5.0.12 | MIT | Copyright Julian Gruber &lt;julian@juliangruber.com&gt; | [L25](#l25) |
| [content-disposition](https://github.com/jshttp/content-disposition) | 3.0.0 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson | [L20](#l20) |
| [cookie](https://github.com/jshttp/cookie) | 1.1.1 | MIT | Copyright (c) 2012-2014 Roman Shtylman &lt;shtylman@gmail.com&gt;<br>Copyright (c) 2015 Douglas Christopher Wilson &lt;doug@somethingdoug.com&gt; | [L20](#l20) |
| [cookie](https://github.com/jshttp/cookie) | 2.0.1 | MIT | Copyright (c) 2012-2014 Roman Shtylman &lt;shtylman@gmail.com&gt;<br>Copyright (c) 2015 Douglas Christopher Wilson &lt;doug@somethingdoug.com&gt; | [L20](#l20) |
| [croner](https://github.com/hexagon/croner) | 10.0.1 | MIT | Copyright (c) 2015-2021 Hexagon &lt;github.com/Hexagon&gt; | [L19](#l19) |
| [debug](https://github.com/debug-js/debug) | 4.4.3 | MIT | Copyright (c) 2014-2017 TJ Holowaychuk &lt;tj@vision-media.ca&gt;<br>Copyright (c) 2018-2021 Josh Junon | [L20](#l20) |
| [deepmerge-ts](https://github.com/RebeccaStevens/deepmerge-ts) | 8.0.2 | BSD-3-Clause | Copyright (c) 2021, Rebecca Stevens | [L11](#l11) |
| [define-data-property](https://github.com/ljharb/define-data-property) | 1.1.4 | MIT | Copyright (c) 2023 Jordan Harband | [L19](#l19) |
| [define-properties](https://github.com/ljharb/define-properties) | 1.2.1 | MIT | Copyright (C) 2015 Jordan Harband | [L19](#l19) |
| [depd](https://github.com/dougwilson/nodejs-depd) | 2.0.0 | MIT | Copyright (c) 2014-2018 Douglas Christopher Wilson | [L20](#l20) |
| [dequal](https://github.com/lukeed/dequal) | 2.0.3 | MIT | Copyright (c) Luke Edwards &lt;luke.edwards05@gmail.com&gt; (lukeed.com) | [L19](#l19) |
| [detect-libc](https://github.com/lovell/detect-libc) | 2.1.2 | Apache-2.0 | Author: Lovell Fuller (no copyright notice in the package) | [L02](#l02) |
| [dom-serializer](https://github.com/cheeriojs/dom-serializer) | 2.0.0 | MIT | Copyright (c) 2014 The cheeriojs contributors | [L20](#l20) |
| [domelementtype](https://github.com/fb55/domelementtype) | 2.3.0 | BSD-2-Clause | Copyright (c) Felix Böhm | [L06](#l06) |
| [domhandler](https://github.com/fb55/domhandler) | 5.0.3 | BSD-2-Clause | Copyright (c) Felix Böhm | [L06](#l06) |
| [domutils](https://github.com/fb55/domutils) | 3.2.2 | BSD-2-Clause | Copyright (c) Felix Böhm | [L06](#l06) |
| [dotenv](https://github.com/motdotla/dotenv) | 17.4.2 | BSD-2-Clause | Copyright (c) 2015, Scott Motte | [L07](#l07) |
| [encoding-japanese](https://github.com/polygonplanet/encoding.js) | 2.5.0 | MIT | Copyright (c) 2012-present polygonplanet<br>Copyright (c) Microsoft Corporation. | [L26](#l26) |
| [entities](https://github.com/fb55/entities) | 4.5.0 | BSD-2-Clause | Copyright (c) Felix Böhm | [L06](#l06) |
| [entities](https://github.com/fb55/entities) | 7.0.1 | BSD-2-Clause | Copyright (c) Felix Böhm | [L06](#l06) |
| [es-define-property](https://github.com/ljharb/es-define-property) | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband | [L19](#l19) |
| [es-errors](https://github.com/ljharb/es-errors) | 1.3.0 | MIT | Copyright (c) 2024 Jordan Harband | [L19](#l19) |
| [escape-html](https://github.com/component/escape-html) | 1.0.3 | MIT | Copyright (c) 2012-2013 TJ Holowaychuk<br>Copyright (c) 2015 Andreas Lubbe<br>Copyright (c) 2015 Tiancheng "Timothy" Gu | [L20](#l20) |
| [escape-string-regexp](https://github.com/sindresorhus/escape-string-regexp) | 4.0.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com&gt; (https://sindresorhus.com) | [L19](#l19) |
| [fast-decode-uri-component](https://github.com/delvedor/fast-decode-uri-component) | 1.0.1 | MIT | Copyright (c) 2018 Tomas Della Vedova<br>Copyright (c) 2017 Justin Ridgewell<br>Copyright (c) 2008-2009 Bjoern Hoehrmann &lt;bjoern@hoehrmann.de&gt; | [L19](#l19) |
| [fast-deep-equal](https://github.com/epoberezkin/fast-deep-equal) | 3.1.3 | MIT | Copyright (c) 2017 Evgeny Poberezkin | [L19](#l19) |
| [fast-json-stringify](https://github.com/fastify/fast-json-stringify) | 7.0.1 | MIT | Copyright (c) 2016-present Matteo Collina<br>Copyright (c) 2016-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [fast-querystring](https://github.com/anonrig/fast-querystring) | 1.1.2 | MIT | Copyright (c) 2022 Yagiz Nizipli | [L19](#l19) |
| [fast-sha256](https://github.com/dchest/fast-sha256-js) | 1.3.0 | Unlicense | Author: Dmitry Chestnykh (no copyright notice in the package) | [L29](#l29) |
| [fast-uri](https://github.com/fastify/fast-uri) | 3.1.8 | BSD-3-Clause | Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae<br>Copyright (c) 2021-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L09](#l09) |
| [fast-uri](https://github.com/fastify/fast-uri) | 4.2.1 | BSD-3-Clause | Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae<br>Copyright (c) 2021-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L09](#l09) |
| [fastify](https://github.com/fastify/fastify) | 5.12.5 | MIT | Copyright (c) 2016-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [fastify-plugin](https://github.com/fastify/fastify-plugin) | 6.0.0 | MIT | Copyright (c) 2017-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [fastify-type-provider-zod](https://github.com/turkerdev/fastify-type-provider-zod) | 7.0.0 | MIT | Copyright (c) 2022-2024 turkerdev | [L19](#l19) |
| [fastq](https://github.com/mcollina/fastq) | 1.20.3 | ISC | Copyright (c) 2015-2020, Matteo Collina &lt;matteo.collina@gmail.com&gt; | [L16](#l16) |
| [find-my-way](https://github.com/delvedor/find-my-way) | 9.9.0 | MIT | Copyright (c) 2017-2019 Tomas Della Vedova | [L19](#l19) |
| [flatbuffers](https://github.com/google/flatbuffers) | 25.9.23 | Apache-2.0 | Author: The FlatBuffers project (no copyright notice in the package) | [L02](#l02) |
| [glob](https://github.com/isaacs/node-glob) | 13.0.6 | BlueOak-1.0.0 | Author: Isaac Z. Schlueter (https://blog.izs.me/) (no copyright notice in the package) | [L05](#l05) |
| [global-agent](https://github.com/gajus/global-agent) | 4.1.3 | BSD-3-Clause | Copyright (c) 2026, Gajus Kuizinas (https://gajus.com/) | [L12](#l12) |
| [globalthis](https://github.com/ljharb/System.global) | 1.0.4 | MIT | Copyright (c) 2016 Jordan Harband | [L19](#l19) |
| [gopd](https://github.com/ljharb/gopd) | 1.2.0 | MIT | Copyright (c) 2022 Jordan Harband | [L19](#l19) |
| [guid-typescript](https://github.com/NicolasDeveloper/guid-typescript) | 1.0.9 | ISC | Author: nicolas (no copyright notice in the package) | [L17](#l17) |
| [has-property-descriptors](https://github.com/inspect-js/has-property-descriptors) | 1.0.2 | MIT | Copyright (c) 2022 Inspect JS | [L19](#l19) |
| [he](https://github.com/mathiasbynens/he) | 1.2.0 | MIT | Copyright Mathias Bynens &lt;https://mathiasbynens.be/&gt; | [L19](#l19) |
| [html-to-text](https://github.com/html-to-text/node-html-to-text) | 10.0.1 | MIT | Portions Copyright (c) 2012-2019 werk85 &lt;malte@werk85.de&gt;<br>Portions Copyright (c) 2020-2026 KillyMXI &lt;killy@mxii.eu.org&gt; | [L19](#l19) |
| [htmlparser2](https://github.com/fb55/htmlparser2) | 10.1.0 | MIT | Copyright 2010, 2011, Chris Winberry &lt;chris@winberry.net&gt;. All rights reserved. | [L19](#l19) |
| [http-errors](https://github.com/jshttp/http-errors) | 2.0.1 | MIT | Copyright (c) 2014 Jonathan Ong me@jongleberry.com<br>Copyright (c) 2016 Douglas Christopher Wilson doug@somethingdoug.com | [L19](#l19) |
| [iconv-lite](https://github.com/pillarjs/iconv-lite) | 0.7.3 | MIT | Copyright (c) 2011 Alexander Shtuchkin | [L19](#l19) |
| [imapflow](https://github.com/postalsys/imapflow) | 2.10.2 | MIT | Copyright (c) 2020-2024 Postal Systems OÜ | [L21](#l21) |
| [inherits](https://github.com/isaacs/inherits) | 2.0.4 | ISC | Copyright (c) Isaac Z. Schlueter | [L16](#l16) |
| [ip-address](https://github.com/beaugunderson/ip-address) | 10.7.6 | MIT | Copyright (C) 2011 by Beau Gunderson | [L19](#l19) |
| [ipaddr.js](https://github.com/whitequark/ipaddr.js) | 2.5.0 | MIT | Copyright (C) 2011-2017 whitequark &lt;whitequark@whitequark.org&gt; | [L19](#l19) |
| [jose](https://github.com/panva/jose) | 6.2.17 | MIT | Copyright (c) 2018 Filip Skokan | [L19](#l19) |
| [json-schema-ref-resolver](https://github.com/fastify/json-schema-ref-resolver) | 3.0.0 | MIT | Copyright (c) 2023 Fastify | [L19](#l19) |
| [json-schema-resolver](https://github.com/Eomm/json-schema-resolver) | 3.0.0 | MIT | Copyright (c) 2020 Manuel Spigolon | [L19](#l19) |
| [json-schema-to-ts](https://github.com/ThomasAribart/json-schema-to-ts) | 3.1.1 | MIT | Copyright (c) 2020 Thomas Aribart | [L19](#l19) |
| [json-schema-traverse](https://github.com/epoberezkin/json-schema-traverse) | 1.0.0 | MIT | Copyright (c) 2017 Evgeny Poberezkin | [L19](#l19) |
| [leac](https://github.com/mxxii/leac) | 0.7.0 | MIT | Copyright (c) 2021-2025 KillyMXI &lt;killy@mxii.eu.org&gt; | [L19](#l19) |
| [libbase64](https://github.com/nodemailer/libbase64) | 1.4.1 | MIT | Copyright (c) 2014-2017 Andris Reinman | [L19](#l19) |
| [libmime](https://github.com/nodemailer/libmime) | 5.6.4 | MIT | Copyright (c) 2014-2016 Andris Reinman | [L19](#l19) |
| [libqp](https://github.com/nodemailer/libqp) | 3.0.1 | MIT | Copyright (c) 2014-2022 Andris Reinman | [L19](#l19) |
| [light-my-request](https://github.com/fastify/light-my-request) | 6.6.0 | BSD-3-Clause | Copyright (c) 2017 The Fastify Team<br>Copyright (c) 2012-2017, Project contributors<br>Copyright (c) 2012-2014, Walmart | [L13](#l13) |
| [linkify-it](https://github.com/markdown-it/linkify-it) | 5.0.2 | MIT | Copyright (c) 2015 Vitaly Puzrin. | [L19](#l19) |
| [long](https://github.com/dcodeIO/long.js) | 5.3.2 | Apache-2.0 | Author: Daniel Wirtz (no copyright notice in the package) | [L02](#l02) |
| [lru-cache](https://github.com/isaacs/node-lru-cache) | 11.5.3 | BlueOak-1.0.0 | Author: Isaac Z. Schlueter (no copyright notice in the package) | [L04](#l04) |
| [mailparser](https://github.com/nodemailer/mailparser) | 3.14.2 | MIT | Copyright (c) 2020 - 2025 Andris Reinman | [L21](#l21) |
| [matcher](https://github.com/sindresorhus/matcher) | 4.0.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com&gt; (https://sindresorhus.com) | [L19](#l19) |
| [mime](https://github.com/broofa/mime) | 3.0.0 | MIT | Copyright (c) 2010 Benjamin Thomas, Robert Kieffer | [L19](#l19) |
| [minimatch](https://github.com/isaacs/minimatch) | 10.2.6 | BlueOak-1.0.0 | Author: Isaac Z. Schlueter (http://blog.izs.me) (no copyright notice in the package) | [L04](#l04) |
| [minipass](https://github.com/isaacs/minipass) | 7.1.3 | BlueOak-1.0.0 | Author: Isaac Z. Schlueter (http://blog.izs.me/) (no copyright notice in the package) | [L04](#l04) |
| [ms](https://github.com/vercel/ms) | 2.1.3 | MIT | Copyright (c) 2020 Vercel, Inc. | [L19](#l19) |
| [node-addon-api](https://github.com/nodejs/node-addon-api) | 8.9.2 | MIT | Copyright (c) 2017 [Node.js API collaborators](https://github.com/nodejs/node-addon-api#collaborators) | [L19](#l19) |
| [nodemailer](https://github.com/nodemailer/nodemailer) | 10.3.1 | MIT-0 | Copyright (c) 2011-2023 Andris Reinman | [L21](#l21) |
| [oauth4webapi](https://github.com/panva/oauth4webapi) | 3.8.8 | MIT | Copyright (c) 2022 Filip Skokan | [L19](#l19) |
| [object-keys](https://github.com/ljharb/object-keys) | 1.1.1 | MIT | Copyright (C) 2013 Jordan Harband | [L19](#l19) |
| [on-exit-leak-free](https://github.com/mcollina/on-exit-or-gc) | 2.1.2 | MIT | Copyright (c) 2021 Matteo Collina | [L19](#l19) |
| [onnxruntime-common](https://github.com/Microsoft/onnxruntime) | 1.30.0 | MIT | Copyright (c) Microsoft Corporation | [L19](#l19) |
| [onnxruntime-node](https://github.com/Microsoft/onnxruntime) | 1.30.0 | MIT | Copyright (c) Microsoft Corporation | [L19](#l19) |
| [openapi-types](https://github.com/kogosoftwarellc/open-api/tree/master/packages/openapi-types) | 12.1.3 | MIT | Copyright (c) 2018 Kogo Softare LLC | [L19](#l19) |
| [openid-client](https://github.com/panva/openid-client) | 6.8.9 | MIT | Copyright (c) 2016 Filip Skokan | [L19](#l19) |
| [parseley](https://github.com/mxxii/parseley) | 0.13.1 | MIT | Copyright (c) 2021-2025 KillyMXI &lt;killy@mxii.eu.org&gt; | [L19](#l19) |
| [path-scurry](https://github.com/isaacs/path-scurry) | 2.0.2 | BlueOak-1.0.0 | Author: Isaac Z. Schlueter (https://blog.izs.me) (no copyright notice in the package) | [L04](#l04) |
| [peberminta](https://github.com/mxxii/peberminta) | 0.10.0 | MIT | Copyright (c) 2021-2025 KillyMXI &lt;killy@mxii.eu.org&gt; | [L19](#l19) |
| [pino](https://github.com/pinojs/pino) | 10.3.1 | MIT | Copyright (c) 2016-2025 Matteo Collina, David Mark Clements and the Pino contributors listed at &lt;https://github.com/pinojs/pino#the-team&gt; and in the README file. | [L19](#l19) |
| [pino-abstract-transport](https://github.com/pinojs/pino-abstract-transport) | 3.0.0 | MIT | Copyright (c) 2021 pino | [L19](#l19) |
| [pino-std-serializers](https://github.com/pinojs/pino-std-serializers) | 7.1.0 | MIT | Copyright Mateo Collina, David Mark Clements, James Sumners | [L19](#l19) |
| [platform](https://github.com/bestiejs/platform.js) | 1.3.6 | MIT | Copyright 2014-2020 Benjamin Tan<br>Copyright 2011-2013 John-David Dalton | [L19](#l19) |
| [process-warning](https://github.com/fastify/process-warning) | 4.0.1 | MIT | Copyright (c) Fastify | [L19](#l19) |
| [process-warning](https://github.com/fastify/process-warning) | 5.1.0 | MIT | Copyright (c) 2020-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [protobufjs](https://github.com/protobufjs/protobuf.js) | 7.6.6 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. | [L14](#l14) |
| [punycode.js](https://github.com/mathiasbynens/punycode.js) | 2.3.1 | MIT | Copyright Mathias Bynens &lt;https://mathiasbynens.be/&gt; | [L19](#l19) |
| [quick-format-unescaped](https://github.com/davidmarkclements/quick-format) | 4.0.4 | MIT | Copyright (c) 2016-2019 David Mark Clements | [L19](#l19) |
| [real-require](https://github.com/pinojs/real-require) | 0.2.0 | MIT | Copyright (c) 2021 Paolo Insogna and the real-require contributors | [L19](#l19) |
| [real-require](https://github.com/pinojs/real-require) | 1.0.0 | MIT | Copyright (c) 2021 Paolo Insogna and the real-require contributors | [L19](#l19) |
| [require-from-string](https://github.com/floatdrop/require-from-string) | 2.0.2 | MIT | Copyright (c) Vsevolod Strukchinsky &lt;floatdrop@gmail.com&gt; (github.com/floatdrop) | [L19](#l19) |
| [ret](https://github.com/fent/ret.js) | 0.5.0 | MIT | Copyright (C) 2011 by fent | [L19](#l19) |
| [reusify](https://github.com/mcollina/reusify) | 1.1.0 | MIT | Copyright (c) 2015-2024 Matteo Collina | [L19](#l19) |
| [rfdc](https://github.com/davidmarkclements/rfdc) | 1.4.1 | MIT | Copyright 2019 "David Mark Clements &lt;david.mark.clements@gmail.com&gt;" | [L19](#l19) |
| [safe-regex2](https://github.com/fastify/safe-regex2) | 5.1.1 | MIT | Copyright (c) 2019-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt; | [L19](#l19) |
| [safe-stable-stringify](https://github.com/BridgeAR/safe-stable-stringify) | 2.5.0 | MIT | Copyright (c) Ruben Bridgewater | [L19](#l19) |
| [safer-buffer](https://github.com/ChALkeR/safer-buffer) | 2.1.2 | MIT | Copyright (c) 2018 Nikita Skovoroda &lt;chalkerx@gmail.com&gt; | [L19](#l19) |
| [secure-json-parse](https://github.com/fastify/secure-json-parse) | 4.1.0 | BSD-3-Clause | Copyright (c) 2019, Sideway Inc, and project contributors<br>Copyright (c) 2019-present The Fastify team | [L15](#l15) |
| [selderee](https://github.com/mxxii/selderee) | 0.12.0 | MIT | Copyright (c) 2021-2026 KillyMXI &lt;killy@mxii.eu.org&gt; | [L19](#l19) |
| [semver](https://github.com/npm/node-semver) | 7.8.5 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors | [L16](#l16) |
| [serialize-error](https://github.com/sindresorhus/serialize-error) | 8.1.0 | MIT | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com&gt; (https://sindresorhus.com) | [L19](#l19) |
| [set-cookie-parser](https://github.com/nfriedly/set-cookie-parser) | 2.7.2 | MIT | Copyright (c) 2015 Nathan Friedly &lt;nathan@nfriedly.com&gt; (http://nfriedly.com/) | [L19](#l19) |
| [setprototypeof](https://github.com/wesleytodd/setprototypeof) | 1.2.0 | ISC | Copyright (c) 2015, Wes Todd | [L16](#l16) |
| [sharp](https://github.com/lovell/sharp) | 0.35.5 | Apache-2.0 | Copyright 2013 Lovell Fuller and others | [L03](#l03) |
| [smart-buffer](https://github.com/JoshGlazebrook/smart-buffer) | 4.2.0 | MIT | Copyright (c) 2013-2017 Josh Glazebrook | [L19](#l19) |
| [socks](https://github.com/JoshGlazebrook/socks) | 2.8.10 | MIT | Copyright (c) 2013 Josh Glazebrook | [L19](#l19) |
| [sonic-boom](https://github.com/pinojs/sonic-boom) | 4.2.1 | MIT | Copyright (c) 2017 Matteo Collina | [L19](#l19) |
| [split2](https://github.com/mcollina/split2) | 4.2.0 | ISC | Copyright (c) 2014-2018, Matteo Collina &lt;hello@matteocollina.com&gt; | [L16](#l16) |
| [standardwebhooks](https://github.com/standard-webhooks/standard-webhooks) | 1.1.1 | MIT | Author: Standard Webhooks (no copyright notice in the package) | [L19](#l19) |
| [statuses](https://github.com/jshttp/statuses) | 2.0.2 | MIT | Copyright (c) 2014 Jonathan Ong &lt;me@jongleberry.com&gt;<br>Copyright (c) 2016 Douglas Christopher Wilson &lt;doug@somethingdoug.com&gt; | [L19](#l19) |
| [thread-stream](https://github.com/mcollina/thread-stream) | 4.2.0 | MIT | Copyright (c) 2021 Matteo Collina | [L19](#l19) |
| [tlds](https://github.com/stephenmathieson/node-tlds) | 1.261.0 | MIT | Copyright (c) 2013 Stephen Mathieson and 2020 Richie Bendall | [L19](#l19) |
| [toad-cache](https://github.com/kibertoad/toad-cache) | 3.7.4 | MIT | Copyright (c) 2023 Igor Savin | [L19](#l19) |
| [toidentifier](https://github.com/component/toidentifier) | 1.0.1 | MIT | Copyright (c) 2016 Douglas Christopher Wilson &lt;doug@somethingdoug.com&gt; | [L19](#l19) |
| [ts-algebra](https://github.com/ThomasAribart/ts-algebra) | 2.0.0 | MIT | Copyright (c) 2020 Thomas Aribart | [L19](#l19) |
| [tslib](https://github.com/Microsoft/tslib) | 2.8.1 | 0BSD | Copyright (c) Microsoft Corporation. | [L01](#l01) |
| [type-fest](https://github.com/sindresorhus/type-fest) | 0.20.2 | MIT (chosen from MIT OR CC0-1.0) | Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com&gt; (https:/sindresorhus.com) | [L19](#l19) |
| [uc.micro](https://github.com/markdown-it/uc.micro) | 2.1.0 | MIT | Copyright Mathias Bynens &lt;https://mathiasbynens.be/&gt; | [L19](#l19) |
| [undici-types](https://github.com/nodejs/undici) | 6.21.0 | MIT | Copyright (c) Matteo Collina and Undici contributors | [L19](#l19) |
| [uqr](https://github.com/unjs/uqr) | 0.1.3 | MIT | Copyright (c) Project Nayuki<br>Copyright (c) 2023 Anthony Fu &lt;https://github.com/antfu&gt; | [L19](#l19) |
| [yaml](https://github.com/eemeli/yaml) | 2.9.1 | ISC | Copyright Eemeli Aro &lt;eemeli@gmail.com&gt; | [L16](#l16) |
| [zod](https://github.com/colinhacks/zod) | 4.6.5 | MIT | Copyright (c) 2025 Colin McDonnell | [L19](#l19) |
 
## 4. Native libraries in the image
 
### 4.1 libvips (sharp)
 
`@img/sharp-libvips-linux-x64` / `-arm64` contain [libvips](https://github.com/libvips/libvips) and the libraries it depends on, prebuilt as shared libraries (`lib/*.so*`). libvips and several of these libraries are licensed under the [GNU Lesser General Public License v3](#gnu-lesser-general-public-license-v3).
 
- They are dynamically linked and can be replaced by your own build of the same libraries.
- **Corresponding source:** libvips 8.18.7: <https://github.com/libvips/libvips/releases/tag/v8.18.7>. The build scripts with the exact source URLs and versions of every library below: [lovell/sharp-libvips v1.3.4](https://github.com/lovell/sharp-libvips/tree/v1.3.4).
- The license overview of the package is also in the image: `node_modules/@img/sharp-libvips-linux-*/README.md`.
| Library | Version | License |
|---|---|---|
| aom | 3.15.1 | BSD 2-Clause + [Alliance for Open Media Patent License 1.0](https://aomedia.org/license/patent-license/) |
| cairo | 1.18.6 | Mozilla Public License 1.1 |
| cgif | 0.5.4 | MIT License |
| expat | 2.8.5 | MIT License |
| fontconfig | 2.18.3 | [fontconfig License](https://gitlab.freedesktop.org/fontconfig/fontconfig/blob/main/COPYING) (BSD-like) |
| freetype | 2.14.3 | [freetype License](https://git.savannah.gnu.org/cgit/freetype/freetype2.git/tree/docs/FTL.TXT) (BSD-like) |
| fribidi | 1.0.17 | LGPLv3 |
| glib | 2.90.0 | LGPLv3 |
| harfbuzz | 14.5.0 | MIT License |
| highway | 1.4.0 | BSD 3-Clause |
| lcms | 2.19.1 | MIT License |
| libarchive | 3.8.9 | BSD 2-Clause |
| libexif | 0.6.26 | LGPLv3 |
| libffi | 3.8.0 | MIT License |
| libheif | 1.23.5 | LGPLv3 |
| libimagequant | 2.4.1 | [BSD 2-Clause](https://github.com/lovell/libimagequant/blob/main/COPYRIGHT) |
| libnsgif | (part of libvips) | MIT License |
| libpng | 1.6.58 | [libpng License](https://github.com/pnggroup/libpng/blob/master/LICENSE) |
| librsvg | 2.63.2 | LGPLv3 |
| libtiff | 4.7.2 | [libtiff License](https://gitlab.com/libtiff/libtiff/blob/master/LICENSE.md) (BSD-like) |
| libultrahdr | 2.0.2 | MIT License |
| libvips | 8.18.7 | LGPLv3 |
| libwebp | 1.6.0 | New BSD License |
| libxml2 | 2.15.4 | MIT License |
| mozjpeg | 0826579 | [zlib License, IJG License, BSD 3-Clause](https://github.com/mozilla/mozjpeg/blob/master/LICENSE.md) |
| pango | 1.58.2 | LGPLv3 |
| pixman | 0.46.4 | MIT License |
| proxy-libintl | 0.5 | LGPLv3 |
| zlib-ng | 2.3.3 | [zlib License](https://github.com/zlib-ng/zlib-ng/blob/develop/LICENSE.md) |
 
### 4.2 ONNX Runtime
 
`onnxruntime-node` contains the native ONNX Runtime library (`libonnxruntime.so`), Copyright (c) Microsoft Corporation, MIT License. The CUDA image additionally contains the CUDA execution provider from the NuGet package `Microsoft.ML.OnnxRuntime.Gpu.Linux` 1.30.0 (same copyright and license). Transformers.js includes the JavaScript glue code of ONNX Runtime Web (MIT, Microsoft Corporation).
 
ONNX Runtime is built with third-party components under their own licenses, listed in its [ThirdPartyNotices.txt](https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt).
 
### 4.3 PDFium
 
`@hyzyla/pdfium` contains [PDFium](https://pdfium.googlesource.com/pdfium/) compiled to WebAssembly (`pdfium.wasm`, built with [pdfium-lib](https://github.com/paulocoutinhox/pdfium-lib)). PDFium: Copyright 2014 The PDFium Authors, licensed under the [BSD 3-Clause License and the Apache License 2.0](https://pdfium.googlesource.com/pdfium/+/main/LICENSE). PDFium contains third-party libraries under their own licenses, see [pdfium/third_party](https://pdfium.googlesource.com/pdfium/+/main/third_party/).
 
### 4.4 SQLite
 
The prebuilt binary of `better-sqlite3` contains [SQLite](https://sqlite.org/), which is in the [public domain](https://sqlite.org/copyright.html).
 
## 5. Web interface
 
The web interface in `dist/public` is a Vite build. It bundles the following packages (in minified form) and the [Geist](https://github.com/vercel/geist-font) fonts (`assets/geist-*.woff2`, SIL Open Font License 1.1). The generated stylesheet contains code of Tailwind CSS, and the JavaScript contains Vite's module preload helper.
 
| Package | Version | License | Copyright | Text |
|---|---|---|---|---|
| [@fontsource-variable/geist](https://github.com/fontsource/font-files) | 5.3.0 | OFL-1.1 | Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font) Geist-Italic[wght].ttf: Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font) | [L28](#l28) |
| [@fontsource-variable/geist-mono](https://github.com/fontsource/font-files) | 5.3.0 | OFL-1.1 | Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font.git) GeistMono-Italic[wght].ttf: Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font.git) | [L28](#l28) |
| [dompurify](https://github.com/cure53/DOMPurify) | 3.4.16 | Apache-2.0 (chosen from MPL-2.0 OR Apache-2.0) | Copyright (c) Cure53 and other contributors | [L02](#l02) |
| [lucide-react](https://github.com/lucide-icons/lucide) | 1.49.0 | ISC | Copyright (c) 2026 Lucide Icons and Contributors<br>Copyright (c) 2013-present Cole Bemis | [L18](#l18) |
| [marked](https://github.com/markedjs/marked) | 18.0.14 | MIT | Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/)<br>Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)<br>Copyright © 2004, John Gruber | [L27](#l27) |
| [react](https://github.com/react/react) | 19.3.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. | [L19](#l19) |
| [react-dom](https://github.com/react/react) | 19.3.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. | [L19](#l19) |
| [regexparam](https://github.com/lukeed/regexparam) | 3.0.0 | MIT | Copyright (c) Luke Edwards &lt;luke.edwards05@gmail.com&gt; (lukeed.com) | [L19](#l19) |
| [scheduler](https://github.com/react/react) | 0.28.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. | [L19](#l19) |
| [tailwindcss](https://github.com/tailwindlabs/tailwindcss) | 4.3.3 | MIT | Copyright (c) Tailwind Labs, Inc. | [L19](#l19) |
| [use-sync-external-store](https://github.com/react/react) | 1.7.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. | [L19](#l19) |
| [vite](https://github.com/vitejs/vite) | 8.3.7 | MIT | Copyright (c) 2019-present, VoidZero Inc. and Vite contributors | [L19](#l19) |
| [wouter](https://github.com/molefrog/wouter) | 3.13.0 | Unlicense | Author: Alexey Taktarov (no copyright notice in the package) | [L30](#l30) |
 
## 6. Base images
 
- **CPU (`latest`):** based on [`node:22-bookworm-slim`](https://hub.docker.com/_/node) (Debian 12 and Node.js 22). The copyright and license information of the Debian packages is in the image under `/usr/share/doc/*/copyright`. Node.js: MIT License together with the licenses of its bundled components, see [Node.js LICENSE](https://github.com/nodejs/node/blob/v22.x/LICENSE).
- **CUDA (`latest-cuda`):** based on [`nvidia/cuda:13.0.3-cudnn-runtime-ubuntu24.04`](https://hub.docker.com/r/nvidia/cuda) (Ubuntu 24.04, CUDA runtime, cuDNN). The NVIDIA components are subject to NVIDIA's license terms, see the [CUDA EULA](https://docs.nvidia.com/cuda/eula/) and the image page. The Node.js binary is copied from `node:22-bookworm-slim` ([Node.js LICENSE](https://github.com/nodejs/node/blob/v22.x/LICENSE)).
## 7. Downloaded at runtime, not part of the image
 
Paperless-AI downloads the following only when the feature is used, directly from the source to your instance. They are listed for transparency; their own licenses apply.
 
| Component | Used for | Source | License |
|---|---|---|---|
| PaddleOCR models ([section 2](#2-ocr-paddleocr)) | OCR | huggingface.co (or `HF_ENDPOINT`) | Apache-2.0 |
| [Xenova/multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small), ONNX conversion of [intfloat/multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small) | local embeddings for RAG (default model) | huggingface.co | MIT |
| [@matbee/libreoffice-converter](https://github.com/matbeedotcom/libreoffice-document-converter) 2.7.2, LibreOffice compiled to WebAssembly | Office documents in the built-in archive | registry.npmjs.org | MPL-2.0 |
 
Embedding or OCR models you configure yourself come with their own licenses.
 
## 8. Trademarks
 
PaddleOCR and PaddlePaddle, ONNX Runtime, Hugging Face, PDFium, SQLite, LibreOffice and all other product names are names or trademarks of their respective owners. They are used only to identify the software. Paperless-AI is an independent project and is not affiliated with or endorsed by any of them. The Patreon, PayPal, Ko-fi and Buy Me a Coffee logos in the web interface (`support/*.svg`) are trademarks of their owners and only link to the respective donation pages.
 
## 9. License texts
 
Each text below applies to the packages listed above it, with the copyright notices given there. Copyright lines of the original license files are listed with the packages instead of being repeated in the text.
 
### L01
 
**0BSD** – used by:
 
- tslib 2.8.1: Copyright (c) Microsoft Corporation.
```text
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.
 
THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```
 
### L02
 
**Apache-2.0** – used by:
 
- @huggingface/tokenizers 0.2.0: Author: Hugging Face (no copyright notice in the package)
- @huggingface/transformers 4.3.0: Author: Hugging Face (no copyright notice in the package)
- detect-libc 2.1.2: Author: Lovell Fuller (no copyright notice in the package)
- flatbuffers 25.9.23: Author: The FlatBuffers project (no copyright notice in the package)
- long 5.3.2: Author: Daniel Wirtz (no copyright notice in the package)
- dompurify 3.4.16: Copyright (c) Cure53 and other contributors
```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/
 
   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION
 
   1. Definitions.
 
      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.
 
      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.
 
      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.
 
      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.
 
      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.
 
      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.
 
      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).
 
      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.
 
      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."
 
      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.
 
   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.
 
   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.
 
   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:
 
      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and
 
      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and
 
      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and
 
      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.
 
      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.
 
   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.
 
   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.
 
   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.
 
   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.
 
   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.
 
   END OF TERMS AND CONDITIONS
```
 
### L03
 
**Apache-2.0** – used by:
 
- @img/sharp-linux-x64 0.35.5: Copyright 2013 Lovell Fuller and others
- sharp 0.35.5: Copyright 2013 Lovell Fuller and others
```text
Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/
 
TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION
 
1. Definitions.
 
"License" shall mean the terms and conditions for use, reproduction, and
distribution as defined by Sections 1 through 9 of this document.
 
"Licensor" shall mean the copyright owner or entity authorized by the copyright
owner that is granting the License.
 
"Legal Entity" shall mean the union of the acting entity and all other entities
that control, are controlled by, or are under common control with that entity.
For the purposes of this definition, "control" means (i) the power, direct or
indirect, to cause the direction or management of such entity, whether by
contract or otherwise, or (ii) ownership of fifty percent (50%) or more of the
outstanding shares, or (iii) beneficial ownership of such entity.
 
"You" (or "Your") shall mean an individual or Legal Entity exercising
permissions granted by this License.
 
"Source" form shall mean the preferred form for making modifications, including
but not limited to software source code, documentation source, and configuration
files.
 
"Object" form shall mean any form resulting from mechanical transformation or
translation of a Source form, including but not limited to compiled object code,
generated documentation, and conversions to other media types.
 
"Work" shall mean the work of authorship, whether in Source or Object form, made
available under the License, as indicated by a copyright notice that is included
in or attached to the work (an example is provided in the Appendix below).
 
"Derivative Works" shall mean any work, whether in Source or Object form, that
is based on (or derived from) the Work and for which the editorial revisions,
annotations, elaborations, or other modifications represent, as a whole, an
original work of authorship. For the purposes of this License, Derivative Works
shall not include works that remain separable from, or merely link (or bind by
name) to the interfaces of, the Work and Derivative Works thereof.
 
"Contribution" shall mean any work of authorship, including the original version
of the Work and any modifications or additions to that Work or Derivative Works
thereof, that is intentionally submitted to Licensor for inclusion in the Work
by the copyright owner or by an individual or Legal Entity authorized to submit
on behalf of the copyright owner. For the purposes of this definition,
"submitted" means any form of electronic, verbal, or written communication sent
to the Licensor or its representatives, including but not limited to
communication on electronic mailing lists, source code control systems, and
issue tracking systems that are managed by, or on behalf of, the Licensor for
the purpose of discussing and improving the Work, but excluding communication
that is conspicuously marked or otherwise designated in writing by the copyright
owner as "Not a Contribution."
 
"Contributor" shall mean Licensor and any individual or Legal Entity on behalf
of whom a Contribution has been received by Licensor and subsequently
incorporated within the Work.
 
2. Grant of Copyright License.
 
Subject to the terms and conditions of this License, each Contributor hereby
grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free,
irrevocable copyright license to reproduce, prepare Derivative Works of,
publicly display, publicly perform, sublicense, and distribute the Work and such
Derivative Works in Source or Object form.
 
3. Grant of Patent License.
 
Subject to the terms and conditions of this License, each Contributor hereby
grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free,
irrevocable (except as stated in this section) patent license to make, have
made, use, offer to sell, sell, import, and otherwise transfer the Work, where
such license applies only to those patent claims licensable by such Contributor
that are necessarily infringed by their Contribution(s) alone or by combination
of their Contribution(s) with the Work to which such Contribution(s) was
submitted. If You institute patent litigation against any entity (including a
cross-claim or counterclaim in a lawsuit) alleging that the Work or a
Contribution incorporated within the Work constitutes direct or contributory
patent infringement, then any patent licenses granted to You under this License
for that Work shall terminate as of the date such litigation is filed.
 
4. Redistribution.
 
You may reproduce and distribute copies of the Work or Derivative Works thereof
in any medium, with or without modifications, and in Source or Object form,
provided that You meet the following conditions:
 
You must give any other recipients of the Work or Derivative Works a copy of
this License; and
You must cause any modified files to carry prominent notices stating that You
changed the files; and
You must retain, in the Source form of any Derivative Works that You distribute,
all copyright, patent, trademark, and attribution notices from the Source form
of the Work, excluding those notices that do not pertain to any part of the
Derivative Works; and
If the Work includes a "NOTICE" text file as part of its distribution, then any
Derivative Works that You distribute must include a readable copy of the
attribution notices contained within such NOTICE file, excluding those notices
that do not pertain to any part of the Derivative Works, in at least one of the
following places: within a NOTICE text file distributed as part of the
Derivative Works; within the Source form or documentation, if provided along
with the Derivative Works; or, within a display generated by the Derivative
Works, if and wherever such third-party notices normally appear. The contents of
the NOTICE file are for informational purposes only and do not modify the
License. You may add Your own attribution notices within Derivative Works that
You distribute, alongside or as an addendum to the NOTICE text from the Work,
provided that such additional attribution notices cannot be construed as
modifying the License.
You may add Your own copyright statement to Your modifications and may provide
additional or different license terms and conditions for use, reproduction, or
distribution of Your modifications, or for any such Derivative Works as a whole,
provided Your use, reproduction, and distribution of the Work otherwise complies
with the conditions stated in this License.
 
5. Submission of Contributions.
 
Unless You explicitly state otherwise, any Contribution intentionally submitted
for inclusion in the Work by You to the Licensor shall be under the terms and
conditions of this License, without any additional terms or conditions.
Notwithstanding the above, nothing herein shall supersede or modify the terms of
any separate license agreement you may have executed with Licensor regarding
such Contributions.
 
6. Trademarks.
 
This License does not grant permission to use the trade names, trademarks,
service marks, or product names of the Licensor, except as required for
reasonable and customary use in describing the origin of the Work and
reproducing the content of the NOTICE file.
 
7. Disclaimer of Warranty.
 
Unless required by applicable law or agreed to in writing, Licensor provides the
Work (and each Contributor provides its Contributions) on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied,
including, without limitation, any warranties or conditions of TITLE,
NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE. You are
solely responsible for determining the appropriateness of using or
redistributing the Work and assume any risks associated with Your exercise of
permissions under this License.
 
8. Limitation of Liability.
 
In no event and under no legal theory, whether in tort (including negligence),
contract, or otherwise, unless required by applicable law (such as deliberate
and grossly negligent acts) or agreed to in writing, shall any Contributor be
liable to You for damages, including any direct, indirect, special, incidental,
or consequential damages of any character arising as a result of this License or
out of the use or inability to use the Work (including but not limited to
damages for loss of goodwill, work stoppage, computer failure or malfunction, or
any and all other commercial damages or losses), even if such Contributor has
been advised of the possibility of such damages.
 
9. Accepting Warranty or Additional Liability.
 
While redistributing the Work or Derivative Works thereof, You may choose to
offer, and charge a fee for, acceptance of support, warranty, indemnity, or
other liability obligations and/or rights consistent with this License. However,
in accepting such obligations, You may act only on Your own behalf and on Your
sole responsibility, not on behalf of any other Contributor, and only if You
agree to indemnify, defend, and hold each Contributor harmless for any liability
incurred by, or claims asserted against, such Contributor by reason of your
accepting any such warranty or additional liability.
 
END OF TERMS AND CONDITIONS
```
 
### L04
 
**BlueOak-1.0.0** – used by:
 
- lru-cache 11.5.3: Author: Isaac Z. Schlueter (no copyright notice in the package)
- minimatch 10.2.6: Author: Isaac Z. Schlueter (http://blog.izs.me) (no copyright notice in the package)
- minipass 7.1.3: Author: Isaac Z. Schlueter (http://blog.izs.me/) (no copyright notice in the package)
- path-scurry 2.0.2: Author: Isaac Z. Schlueter (https://blog.izs.me) (no copyright notice in the package)
```text
# Blue Oak Model License
 
Version 1.0.0
 
## Purpose
 
This license gives everyone as much permission to work with
this software as possible, while protecting contributors
from liability.
 
## Acceptance
 
In order to receive this license, you must agree to its
rules.  The rules of this license are both obligations
under that agreement and conditions to your license.
You must not do anything with this software that triggers
a rule that you cannot or will not follow.
 
## Copyright
 
Each contributor licenses you to do everything with this
software that would otherwise infringe that contributor's
copyright in it.
 
## Notices
 
You must ensure that everyone who gets a copy of
any part of this software from you, with or without
changes, also gets the text of this license or a link to
<https://blueoakcouncil.org/license/1.0.0>.
 
## Excuse
 
If anyone notifies you in writing that you have not
complied with [Notices](#notices), you can keep your
license by taking all practical steps to comply within 30
days after the notice.  If you do not do so, your license
ends immediately.
 
## Patent
 
Each contributor licenses you to do everything with this
software that would otherwise infringe any patent claims
they can license or become able to license.
 
## Reliability
 
No contributor can revoke this license.
 
## No Liability
 
***As far as the law allows, this software comes as is,
without any warranty or condition, and no contributor
will be liable to anyone for any damages related to this
software or this license, under any kind of legal claim.***
```
 
### L05
 
**BlueOak-1.0.0** – used by:
 
- glob 13.0.6: Author: Isaac Z. Schlueter (https://blog.izs.me/) (no copyright notice in the package)
```text
All packages under `src/` are licensed according to the terms in
their respective `LICENSE` or `LICENSE.md` files.
 
The remainder of this project is licensed under the Blue Oak
Model License, as follows:
 
-----
 
# Blue Oak Model License
 
Version 1.0.0
 
## Purpose
 
This license gives everyone as much permission to work with
this software as possible, while protecting contributors
from liability.
 
## Acceptance
 
In order to receive this license, you must agree to its
rules.  The rules of this license are both obligations
under that agreement and conditions to your license.
You must not do anything with this software that triggers
a rule that you cannot or will not follow.
 
## Copyright
 
Each contributor licenses you to do everything with this
software that would otherwise infringe that contributor's
copyright in it.
 
## Notices
 
You must ensure that everyone who gets a copy of
any part of this software from you, with or without
changes, also gets the text of this license or a link to
<https://blueoakcouncil.org/license/1.0.0>.
 
## Excuse
 
If anyone notifies you in writing that you have not
complied with [Notices](#notices), you can keep your
license by taking all practical steps to comply within 30
days after the notice.  If you do not do so, your license
ends immediately.
 
## Patent
 
Each contributor licenses you to do everything with this
software that would otherwise infringe any patent claims
they can license or become able to license.
 
## Reliability
 
No contributor can revoke this license.
 
## No Liability
 
***As far as the law allows, this software comes as is,
without any warranty or condition, and no contributor
will be liable to anyone for any damages related to this
software or this license, under any kind of legal claim.***
```
 
### L06
 
**BSD-2-Clause** – used by:
 
- domelementtype 2.3.0: Copyright (c) Felix Böhm
- domhandler 5.0.3: Copyright (c) Felix Böhm
- domutils 3.2.2: Copyright (c) Felix Böhm
- entities 4.5.0: Copyright (c) Felix Böhm
- entities 7.0.1: Copyright (c) Felix Böhm
```text
Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
 
Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
 
Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
 
THIS IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
 
### L07
 
**BSD-2-Clause** – used by:
 
- dotenv 17.4.2: Copyright (c) 2015, Scott Motte
```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
 
* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.
 
* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.
 
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
 
### L08
 
**BSD-3-Clause** – used by:
 
- @protobufjs/aspromise 1.1.2: Copyright (c) 2016, Daniel Wirtz All rights reserved.
- @protobufjs/base64 1.1.2: Copyright (c) 2016, Daniel Wirtz All rights reserved.
- @protobufjs/codegen 2.0.5: Copyright (c) 2016, Daniel Wirtz All rights reserved.
- @protobufjs/eventemitter 1.1.1: Copyright (c) 2016, Daniel Wirtz All rights reserved.
- @protobufjs/fetch 1.1.1: Copyright (c) 2016, Daniel Wirtz All rights reserved.
- @protobufjs/float 1.0.2: Copyright (c) 2016, Daniel Wirtz All rights reserved.
- @protobufjs/path 1.1.2: Copyright (c) 2016, Daniel Wirtz All rights reserved.
- @protobufjs/pool 1.1.0: Copyright (c) 2016, Daniel Wirtz All rights reserved.
- @protobufjs/utf8 1.1.2: Copyright (c) 2016, Daniel Wirtz All rights reserved.
```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:
 
* Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
* Neither the name of its author, nor the names of its contributors
  may be used to endorse or promote products derived from this software
  without specific prior written permission.
 
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
 
### L09
 
**BSD-3-Clause** – used by:
 
- fast-uri 3.1.8: Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae; Copyright (c) 2021-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- fast-uri 4.2.1: Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae; Copyright (c) 2021-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * The names of any contributors may not be used to endorse or promote
      products derived from this software without specific prior written
      permission.
 
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 
                                  *   *   *
 
The complete list of contributors can be found at:
- https://github.com/garycourt/uri-js/graphs/contributors
```
 
### L10
 
**BSD-3-Clause** – used by:
 
- bcryptjs 3.0.3: Copyright (c) 2012 Nevins Bartolomeo &lt;nevins.bartolomeo@gmail.com&gt;; Copyright (c) 2012 Shane Girish &lt;shaneGirish@gmail.com&gt;; Copyright (c) 2025 Daniel Wirtz &lt;dcode@dcode.io&gt;
```text
bcrypt.js
---------
 
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. The name of the author may not be used to endorse or promote products
   derived from this software without specific prior written permission.
 
THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
 
### L11
 
**BSD-3-Clause** – used by:
 
- deepmerge-ts 8.0.2: Copyright (c) 2021, Rebecca Stevens
```text
BSD 3-Clause License
 
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
 
1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
 
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
 
3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.
 
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
 
### L12
 
**BSD-3-Clause** – used by:
 
- global-agent 4.1.3: Copyright (c) 2026, Gajus Kuizinas (https://gajus.com/)
```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of the Gajus Kuizinas (https://gajus.com/) nor the
      names of its contributors may be used to endorse or promote products
      derived from this software without specific prior written permission.
 
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL ANUARY BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
 
### L13
 
**BSD-3-Clause** – used by:
 
- light-my-request 6.6.0: Copyright (c) 2017 The Fastify Team; Copyright (c) 2012-2017, Project contributors; Copyright (c) 2012-2014, Walmart
```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * The names of any contributors may not be used to endorse or promote
      products derived from this software without specific prior written
      permission.
 
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 
                                  *   *   *
 
The complete list of contributors can be found at:
- https://github.com/hapijs/shot/graphs/contributors
- https://github.com/fastify/light-my-request/graphs/contributors
```
 
### L14
 
**BSD-3-Clause** – used by:
 
- protobufjs 7.6.6: Copyright (c) 2016, Daniel Wirtz All rights reserved.
```text
This license applies to all parts of protobuf.js except those files
either explicitly including or referencing a different license or
located in a directory containing a different LICENSE file.
 
---
 
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:
 
* Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
* Neither the name of its author, nor the names of its contributors
  may be used to endorse or promote products derived from this software
  without specific prior written permission.
 
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 
---
 
Code generated by the command line utilities is owned by the owner
of the input file used when generating it. This code is not
standalone and requires a support library to be linked with it. This
support library is itself covered by the above license.
```
 
### L15
 
**BSD-3-Clause** – used by:
 
- secure-json-parse 4.1.0: Copyright (c) 2019, Sideway Inc, and project contributors; Copyright (c) 2019-present The Fastify team
```text
The Fastify team members are listed at https://github.com/fastify/fastify#team.
 
The complete list of contributors can be found at:
- https://github.com/hapijs/bourne/graphs/contributors
- https://github.com/fastify/secure-json-parse/graphs/contributors
 
Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
 
1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
 
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
 
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.
 
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
 
### L16
 
**ISC** – used by:
 
- fastq 1.20.3: Copyright (c) 2015-2020, Matteo Collina &lt;matteo.collina@gmail.com&gt;
- inherits 2.0.4: Copyright (c) Isaac Z. Schlueter
- semver 7.8.5: Copyright (c) Isaac Z. Schlueter and Contributors
- setprototypeof 1.2.0: Copyright (c) 2015, Wes Todd
- split2 4.2.0: Copyright (c) 2014-2018, Matteo Collina &lt;hello@matteocollina.com&gt;
- yaml 2.9.1: Copyright Eemeli Aro &lt;eemeli@gmail.com&gt;
```text
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.
 
THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```
 
### L17
 
**ISC** (standard text (the package ships no license file)) – used by:
 
- guid-typescript 1.0.9: Author: nicolas (no copyright notice in the package)
```text
ISC License:
 
Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
 
THE SOFTWARE IS PROVIDED "AS IS" AND ISC DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL ISC BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```
 
### L18
 
**ISC** – used by:
 
- lucide-react 1.49.0: Copyright (c) 2026 Lucide Icons and Contributors; Copyright (c) 2013-present Cole Bemis
```text
ISC License
 
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.
 
THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 
---
 
The following Lucide icons are derived from the Feather project:
 
airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out
 
The MIT License (MIT) (for the icons listed above)
 
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
 
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
 
### L19
 
**MIT** – used by:
 
- @anthropic-ai/sdk 0.131.0: Copyright 2023 Anthropic, PBC.
- @babel/runtime 7.29.7: Copyright (c) 2014-present Sebastian McKenzie and other contributors
- @emnapi/runtime 1.11.3: Copyright (c) 2021-present Toyobayashi
- @fastify/accept-negotiator 2.1.0: Copyright (c) 2022-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- @fastify/ajv-compiler 4.0.6: Copyright (c) 2022-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- @fastify/busboy 3.2.6: Copyright Brian White. All rights reserved.; Copyright (c) 2021-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- @fastify/cookie 11.1.2: Copyright (c) 2017-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- @fastify/deepmerge 3.2.4: Copyright (c) 2022-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- @fastify/error 4.2.0: Copyright (c) 2020 Fastify
- @fastify/fast-json-stringify-compiler 5.1.0: Copyright (c) 2022-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- @fastify/forwarded 3.0.2: Copyright (c) 2014-2017 Douglas Christopher Wilson; Copyright (c) 2021-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- @fastify/merge-json-schemas 0.2.1: Copyright (c) 2024 Fastify
- @fastify/multipart 10.1.9: Copyright (c) 2017-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- @fastify/proxy-addr 5.1.1: Copyright (c) 2014-2016 Douglas Christopher Wilson; Copyright (c) 2021-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- @fastify/rate-limit 11.2.0: Copyright (c) 2018-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- @fastify/send 4.1.1: Copyright (c) 2012 TJ Holowaychuk; Copyright (c) 2014-2022 Douglas Christopher Wilson; Copyright (c) 2023-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- @fastify/static 10.1.5: Copyright (c) 2017-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- @fastify/swagger 9.9.1: Copyright (c) 2017-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- @fastify/swagger-ui 6.1.1: Copyright (c) 2022-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- @huggingface/jinja 0.5.10: Copyright (c) 2023 Hugging Face
- @hyzyla/pdfium 3.0.0: Copyright (c) 2012-2023 Scott Chacon and others
- @lukeed/ms 2.0.2: Copyright (c) Luke Edwards &lt;luke.edwards05@gmail.com&gt; (lukeed.com)
- @pinojs/redact 0.4.0: Copyright (c) 2025 pinojs contributors
- @selderee/plugin-htmlparser2 0.12.0: Copyright (c) 2021-2026 KillyMXI &lt;killy@mxii.eu.org&gt;
- @zone-eu/mailsplit 5.4.30: Copyright (c) 2011-2019, 2024 Andris Reinman and Zone Media OÜ
- abstract-logging 2.0.1: Author: James Sumners (no copyright notice in the package)
- adm-zip 0.6.1: Copyright (c) 2012 Another-D-Mention Software and other contributors
- ajv 8.20.0: Copyright (c) 2015-2021 Evgeny Poberezkin
- ajv-formats 3.0.1: Copyright (c) 2020 Evgeny Poberezkin
- atomic-sleep 1.0.0: Copyright (c) 2020 David Mark Clements
- avvio 9.3.0: Copyright (c) 2016-2020 Matteo Collina; Copyright (c) 2020-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- balanced-match 4.0.4: Original code Copyright Julian Gruber &lt;julian@juliangruber.com&gt;; Port to TypeScript Copyright Isaac Z. Schlueter &lt;i@izs.me&gt;
- better-sqlite3 13.0.3: Copyright (c) 2017 Joshua Wise
- croner 10.0.1: Copyright (c) 2015-2021 Hexagon &lt;github.com/Hexagon&gt;
- define-data-property 1.1.4: Copyright (c) 2023 Jordan Harband
- define-properties 1.2.1: Copyright (C) 2015 Jordan Harband
- dequal 2.0.3: Copyright (c) Luke Edwards &lt;luke.edwards05@gmail.com&gt; (lukeed.com)
- es-define-property 1.0.1: Copyright (c) 2024 Jordan Harband
- es-errors 1.3.0: Copyright (c) 2024 Jordan Harband
- escape-string-regexp 4.0.0: Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com&gt; (https://sindresorhus.com)
- fast-decode-uri-component 1.0.1: Copyright (c) 2018 Tomas Della Vedova; Copyright (c) 2017 Justin Ridgewell; Copyright (c) 2008-2009 Bjoern Hoehrmann &lt;bjoern@hoehrmann.de&gt;
- fast-deep-equal 3.1.3: Copyright (c) 2017 Evgeny Poberezkin
- fast-json-stringify 7.0.1: Copyright (c) 2016-present Matteo Collina; Copyright (c) 2016-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- fast-querystring 1.1.2: Copyright (c) 2022 Yagiz Nizipli
- fastify 5.12.5: Copyright (c) 2016-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- fastify-plugin 6.0.0: Copyright (c) 2017-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- fastify-type-provider-zod 7.0.0: Copyright (c) 2022-2024 turkerdev
- find-my-way 9.9.0: Copyright (c) 2017-2019 Tomas Della Vedova
- globalthis 1.0.4: Copyright (c) 2016 Jordan Harband
- gopd 1.2.0: Copyright (c) 2022 Jordan Harband
- has-property-descriptors 1.0.2: Copyright (c) 2022 Inspect JS
- he 1.2.0: Copyright Mathias Bynens &lt;https://mathiasbynens.be/&gt;
- html-to-text 10.0.1: Portions Copyright (c) 2012-2019 werk85 &lt;malte@werk85.de&gt;; Portions Copyright (c) 2020-2026 KillyMXI &lt;killy@mxii.eu.org&gt;
- htmlparser2 10.1.0: Copyright 2010, 2011, Chris Winberry &lt;chris@winberry.net&gt;. All rights reserved.
- http-errors 2.0.1: Copyright (c) 2014 Jonathan Ong me@jongleberry.com; Copyright (c) 2016 Douglas Christopher Wilson doug@somethingdoug.com
- iconv-lite 0.7.3: Copyright (c) 2011 Alexander Shtuchkin
- ip-address 10.7.6: Copyright (C) 2011 by Beau Gunderson
- ipaddr.js 2.5.0: Copyright (C) 2011-2017 whitequark &lt;whitequark@whitequark.org&gt;
- jose 6.2.17: Copyright (c) 2018 Filip Skokan
- json-schema-ref-resolver 3.0.0: Copyright (c) 2023 Fastify
- json-schema-resolver 3.0.0: Copyright (c) 2020 Manuel Spigolon
- json-schema-to-ts 3.1.1: Copyright (c) 2020 Thomas Aribart
- json-schema-traverse 1.0.0: Copyright (c) 2017 Evgeny Poberezkin
- leac 0.7.0: Copyright (c) 2021-2025 KillyMXI &lt;killy@mxii.eu.org&gt;
- libbase64 1.4.1: Copyright (c) 2014-2017 Andris Reinman
- libmime 5.6.4: Copyright (c) 2014-2016 Andris Reinman
- libqp 3.0.1: Copyright (c) 2014-2022 Andris Reinman
- linkify-it 5.0.2: Copyright (c) 2015 Vitaly Puzrin.
- matcher 4.0.0: Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com&gt; (https://sindresorhus.com)
- mime 3.0.0: Copyright (c) 2010 Benjamin Thomas, Robert Kieffer
- ms 2.1.3: Copyright (c) 2020 Vercel, Inc.
- node-addon-api 8.9.2: Copyright (c) 2017 [Node.js API collaborators](https://github.com/nodejs/node-addon-api#collaborators)
- oauth4webapi 3.8.8: Copyright (c) 2022 Filip Skokan
- object-keys 1.1.1: Copyright (C) 2013 Jordan Harband
- on-exit-leak-free 2.1.2: Copyright (c) 2021 Matteo Collina
- onnxruntime-common 1.30.0: Copyright (c) Microsoft Corporation
- onnxruntime-node 1.30.0: Copyright (c) Microsoft Corporation
- openapi-types 12.1.3: Copyright (c) 2018 Kogo Softare LLC
- openid-client 6.8.9: Copyright (c) 2016 Filip Skokan
- parseley 0.13.1: Copyright (c) 2021-2025 KillyMXI &lt;killy@mxii.eu.org&gt;
- peberminta 0.10.0: Copyright (c) 2021-2025 KillyMXI &lt;killy@mxii.eu.org&gt;
- pino 10.3.1: Copyright (c) 2016-2025 Matteo Collina, David Mark Clements and the Pino contributors listed at &lt;https://github.com/pinojs/pino#the-team&gt; and in the README file.
- pino-abstract-transport 3.0.0: Copyright (c) 2021 pino
- pino-std-serializers 7.1.0: Copyright Mateo Collina, David Mark Clements, James Sumners
- platform 1.3.6: Copyright 2014-2020 Benjamin Tan; Copyright 2011-2013 John-David Dalton
- process-warning 4.0.1: Copyright (c) Fastify
- process-warning 5.1.0: Copyright (c) 2020-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- punycode.js 2.3.1: Copyright Mathias Bynens &lt;https://mathiasbynens.be/&gt;
- quick-format-unescaped 4.0.4: Copyright (c) 2016-2019 David Mark Clements
- real-require 0.2.0: Copyright (c) 2021 Paolo Insogna and the real-require contributors
- real-require 1.0.0: Copyright (c) 2021 Paolo Insogna and the real-require contributors
- require-from-string 2.0.2: Copyright (c) Vsevolod Strukchinsky &lt;floatdrop@gmail.com&gt; (github.com/floatdrop)
- ret 0.5.0: Copyright (C) 2011 by fent
- reusify 1.1.0: Copyright (c) 2015-2024 Matteo Collina
- rfdc 1.4.1: Copyright 2019 "David Mark Clements &lt;david.mark.clements@gmail.com&gt;"
- safe-regex2 5.1.1: Copyright (c) 2019-present The Fastify team &lt;https://github.com/fastify/fastify#team&gt;
- safe-stable-stringify 2.5.0: Copyright (c) Ruben Bridgewater
- safer-buffer 2.1.2: Copyright (c) 2018 Nikita Skovoroda &lt;chalkerx@gmail.com&gt;
- selderee 0.12.0: Copyright (c) 2021-2026 KillyMXI &lt;killy@mxii.eu.org&gt;
- serialize-error 8.1.0: Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com&gt; (https://sindresorhus.com)
- set-cookie-parser 2.7.2: Copyright (c) 2015 Nathan Friedly &lt;nathan@nfriedly.com&gt; (http://nfriedly.com/)
- smart-buffer 4.2.0: Copyright (c) 2013-2017 Josh Glazebrook
- socks 2.8.10: Copyright (c) 2013 Josh Glazebrook
- sonic-boom 4.2.1: Copyright (c) 2017 Matteo Collina
- standardwebhooks 1.1.1: Author: Standard Webhooks (no copyright notice in the package)
- statuses 2.0.2: Copyright (c) 2014 Jonathan Ong &lt;me@jongleberry.com&gt;; Copyright (c) 2016 Douglas Christopher Wilson &lt;doug@somethingdoug.com&gt;
- thread-stream 4.2.0: Copyright (c) 2021 Matteo Collina
- tlds 1.261.0: Copyright (c) 2013 Stephen Mathieson and 2020 Richie Bendall
- toad-cache 3.7.4: Copyright (c) 2023 Igor Savin
- toidentifier 1.0.1: Copyright (c) 2016 Douglas Christopher Wilson &lt;doug@somethingdoug.com&gt;
- ts-algebra 2.0.0: Copyright (c) 2020 Thomas Aribart
- type-fest 0.20.2: Copyright (c) Sindre Sorhus &lt;sindresorhus@gmail.com&gt; (https:/sindresorhus.com)
- uc.micro 2.1.0: Copyright Mathias Bynens &lt;https://mathiasbynens.be/&gt;
- undici-types 6.21.0: Copyright (c) Matteo Collina and Undici contributors
- uqr 0.1.3: Copyright (c) Project Nayuki; Copyright (c) 2023 Anthony Fu &lt;https://github.com/antfu&gt;
- zod 4.6.5: Copyright (c) 2025 Colin McDonnell
- react 19.3.0: Copyright (c) Meta Platforms, Inc. and affiliates.
- react-dom 19.3.0: Copyright (c) Meta Platforms, Inc. and affiliates.
- regexparam 3.0.0: Copyright (c) Luke Edwards &lt;luke.edwards05@gmail.com&gt; (lukeed.com)
- scheduler 0.28.0: Copyright (c) Meta Platforms, Inc. and affiliates.
- tailwindcss 4.3.3: Copyright (c) Tailwind Labs, Inc.
- use-sync-external-store 1.7.0: Copyright (c) Meta Platforms, Inc. and affiliates.
- vite 8.3.7: Copyright (c) 2019-present, VoidZero Inc. and Vite contributors
```text
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
 
### L20
 
**MIT** – used by:
 
- content-disposition 3.0.0: Copyright (c) 2014-2017 Douglas Christopher Wilson
- cookie 1.1.1: Copyright (c) 2012-2014 Roman Shtylman &lt;shtylman@gmail.com&gt;; Copyright (c) 2015 Douglas Christopher Wilson &lt;doug@somethingdoug.com&gt;
- cookie 2.0.1: Copyright (c) 2012-2014 Roman Shtylman &lt;shtylman@gmail.com&gt;; Copyright (c) 2015 Douglas Christopher Wilson &lt;doug@somethingdoug.com&gt;
- debug 4.4.3: Copyright (c) 2014-2017 TJ Holowaychuk &lt;tj@vision-media.ca&gt;; Copyright (c) 2018-2021 Josh Junon
- depd 2.0.0: Copyright (c) 2014-2018 Douglas Christopher Wilson
- dom-serializer 2.0.0: Copyright (c) 2014 The cheeriojs contributors
- escape-html 1.0.3: Copyright (c) 2012-2013 TJ Holowaychuk; Copyright (c) 2015 Andreas Lubbe; Copyright (c) 2015 Tiancheng "Timothy" Gu
```text
(The MIT License)
 
Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:
 
The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.
 
THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
 
### L21
 
**MIT, MIT-0** – used by:
 
- imapflow 2.10.2: Copyright (c) 2020-2024 Postal Systems OÜ
- mailparser 3.14.2: Copyright (c) 2020 - 2025 Andris Reinman
- nodemailer 10.3.1: Copyright (c) 2011-2023 Andris Reinman
```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
 
### L22
 
**MIT** – used by:
 
- @img/colour 1.1.0: Copyright (c) 2012 Heather Arthur; Copyright (c) 2011-2016 Heather Arthur &lt;fayearthur@gmail.com&gt;.; Copyright (c) 2016-2021 Josh Junon &lt;josh@junon.me&gt;.; Copyright (c) 2011 Heather Arthur &lt;fayearthur@gmail.com&gt;; Copyright (c) 2015 Dmitry Ivanov
```text
# Licensing
 
## color
 
Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:
 
The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.
 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 
## color-convert
 
Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:
 
The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.
 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 
## color-string
 
Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:
 
The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.
 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 
## color-name
 
The MIT License (MIT)
 
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
 
### L23
 
**MIT** – used by:
 
- @stablelib/base64 1.0.1: Copyright (C) 2016 Dmitry Chestnykh
```text
This software is licensed under the MIT license:
 
Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:
 
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
 
### L24
 
**MIT** – used by:
 
- @types/node 22.20.4: Copyright (c) Microsoft Corporation.
```text
MIT License
 
    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:
 
    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.
 
    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE
```
 
### L25
 
**MIT** – used by:
 
- brace-expansion 5.0.12: Copyright Julian Gruber &lt;julian@juliangruber.com&gt;
```text
MIT License
 
TypeScript port Copyright Isaac Z. Schlueter <i@izs.me>
 
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
 
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
 
### L26
 
**MIT** – used by:
 
- encoding-japanese 2.5.0: Copyright (c) 2012-present polygonplanet; Copyright (c) Microsoft Corporation.
```text
MIT License
 
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
 
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
 
-----
 
Third-Party Licenses and Credits
 
TypeScript declarations and type tests are based on the type definitions for
encoding-japanese from DefinitelyTyped, licensed under the MIT License.
 
Upstream package: @types/encoding-japanese 2.2.1
 
The LICENSE distributed with @types/encoding-japanese states:
 
The LICENSE in the DefinitelyTyped repository states:
 
  Copyrights are respective of each contributor listed at the beginning of
  each definition file.
 
The contributors credited in the upstream package are:
  rhysd (https://github.com/rhysd)
  Piotr Błażejewicz (https://github.com/peterblazejewicz)
 
The MIT License terms stated above apply equally to these files.
```
 
### L27
 
**MIT** – used by:
 
- marked 18.0.14: Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/); Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/); Copyright © 2004, John Gruber
```text
# License information
 
## Contribution License Agreement
 
If you contribute code to this project, you are implicitly allowing your code
to be distributed under the MIT license. You are also implicitly verifying that
all code is your original work. `</legalese>`
 
## Marked
 
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
 
The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.
 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
 
## Markdown
 
http://daringfireball.net/
 
Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
 
* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
* Neither the name “Markdown” nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.
 
This software is provided by the copyright holders and contributors “as is” and any express or implied warranties, including, but not limited to, the implied warranties of merchantability and fitness for a particular purpose are disclaimed. In no event shall the copyright owner or contributors be liable for any direct, indirect, incidental, special, exemplary, or consequential damages (including, but not limited to, procurement of substitute goods or services; loss of use, data, or profits; or business interruption) however caused and on any theory of liability, whether in contract, strict liability, or tort (including negligence or otherwise) arising in any way out of the use of this software, even if advised of the possibility of such damage.
```
 
### L28
 
**OFL-1.1** – used by:
 
- @fontsource-variable/geist 5.3.0: Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font) Geist-Italic[wght].ttf: Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font)
- @fontsource-variable/geist-mono 5.3.0: Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font.git) GeistMono-Italic[wght].ttf: Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font.git)
```text
This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL
 
-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------
 
PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.
 
The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.
 
DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.
 
"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).
 
"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).
 
"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.
 
"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.
 
PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:
 
1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.
 
2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.
 
3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.
 
4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.
 
5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.
 
TERMINATION
This license becomes null and void if any of the above conditions are
not met.
 
DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
 
### L29
 
**Unlicense** – used by:
 
- fast-sha256 1.3.0: Author: Dmitry Chestnykh (no copyright notice in the package)
```text
This is free and unencumbered software released into the public domain.
 
Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.
 
In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.
 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
 
For more information, please refer to <http://unlicense.org>
```
 
### L30
 
**Unlicense** (standard text (the package ships no license file)) – used by:
 
- wouter 3.13.0: Author: Alexey Taktarov (no copyright notice in the package)
```text
This is free and unencumbered software released into the public domain.
 
Anyone is free to copy, modify, publish, use, compile, sell, or distribute this software, either in source code form or as a compiled binary, for any purpose, commercial or non-commercial, and by any means.
 
In jurisdictions that recognize copyright laws, the author or authors of this software dedicate any and all copyright interest in the software to the public domain. We make this dedication for the benefit of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of relinquishment in perpetuity of all present and future rights to this software under copyright law.
 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 
For more information, please refer to <http://unlicense.org/>
```
 
### Apache License 2.0
 
Applies to the PaddleOCR models ([section 2](#2-ocr-paddleocr)), Copyright (c) PaddlePaddle Authors, and to PDFium together with its BSD 3-Clause License ([section 4.3](#43-pdfium)). Full text: [L03](#l03).
 
### GNU Lesser General Public License v3
 
Applies to libvips and the LGPL libraries in [section 4.1](#41-libvips-sharp). The LGPL v3 adds permissions to the GNU General Public License v3, so both texts follow.
 
```text
GNU LESSER GENERAL PUBLIC LICENSE
Version 3, 29 June 2007
 
Copyright (C) 2007 Free Software Foundation, Inc. <http://fsf.org/>
 
Everyone is permitted to copy and distribute verbatim copies of this license document, but changing it is not allowed.
 
This version of the GNU Lesser General Public License incorporates the terms and conditions of version 3 of the GNU General Public License, supplemented by the additional permissions listed below.
 
0. Additional Definitions.
 
As used herein, "this License" refers to version 3 of the GNU Lesser General Public License, and the "GNU GPL" refers to version 3 of the GNU General Public License.
 
"The Library" refers to a covered work governed by this License, other than an Application or a Combined Work as defined below.
 
An "Application" is any work that makes use of an interface provided by the Library, but which is not otherwise based on the Library. Defining a subclass of a class defined by the Library is deemed a mode of using an interface provided by the Library.
 
A "Combined Work" is a work produced by combining or linking an Application with the Library.  The particular version of the Library with which the Combined Work was made is also called the "Linked Version".
 
The "Minimal Corresponding Source" for a Combined Work means the Corresponding Source for the Combined Work, excluding any source code for portions of the Combined Work that, considered in isolation, are based on the Application, and not on the Linked Version.
 
The "Corresponding Application Code" for a Combined Work means the object code and/or source code for the Application, including any data and utility programs needed for reproducing the Combined Work from the Application, but excluding the System Libraries of the Combined Work.
 
1. Exception to Section 3 of the GNU GPL.
You may convey a covered work under sections 3 and 4 of this License without being bound by section 3 of the GNU GPL.
 
2. Conveying Modified Versions.
If you modify a copy of the Library, and, in your modifications, a facility refers to a function or data to be supplied by an Application that uses the facility (other than as an argument passed when the facility is invoked), then you may convey a copy of the modified version:
 
     a) under this License, provided that you make a good faith effort to ensure that, in the event an Application does not supply the function or data, the facility still operates, and performs whatever part of its purpose remains meaningful, or
 
     b) under the GNU GPL, with none of the additional permissions of this License applicable to that copy.
 
3. Object Code Incorporating Material from Library Header Files.
The object code form of an Application may incorporate material from a header file that is part of the Library.  You may convey such object code under terms of your choice, provided that, if the incorporated material is not limited to numerical parameters, data structure layouts and accessors, or small macros, inline functions and templates (ten or fewer lines in length), you do both of the following:
 
     a) Give prominent notice with each copy of the object code that the Library is used in it and that the Library and its use are covered by this License.
 
     b) Accompany the object code with a copy of the GNU GPL and this license document.
 
4. Combined Works.
You may convey a Combined Work under terms of your choice that, taken together, effectively do not restrict modification of the portions of the Library contained in the Combined Work and reverse engineering for debugging such modifications, if you also do each of the following:
 
     a) Give prominent notice with each copy of the Combined Work that the Library is used in it and that the Library and its use are covered by this License.
 
     b) Accompany the Combined Work with a copy of the GNU GPL and this license document.
 
     c) For a Combined Work that displays copyright notices during execution, include the copyright notice for the Library among these notices, as well as a reference directing the user to the copies of the GNU GPL and this license document.
 
     d) Do one of the following:
 
           0) Convey the Minimal Corresponding Source under the terms of this License, and the Corresponding Application Code in a form suitable for, and under terms that permit, the user to recombine or relink the Application with a modified version of the Linked Version to produce a modified Combined Work, in the manner specified by section 6 of the GNU GPL for conveying Corresponding Source.
 
          1) Use a suitable shared library mechanism for linking with the Library.  A suitable mechanism is one that (a) uses at run time a copy of the Library already present on the user's computer system, and (b) will operate properly with a modified version of the Library that is interface-compatible with the Linked Version.
 
     e) Provide Installation Information, but only if you would otherwise be required to provide such information under section 6 of the GNU GPL, and only to the extent that such information is necessary to install and execute a modified version of the Combined Work produced by recombining or relinking the Application with a modified version of the Linked Version. (If you use option 4d0, the Installation Information must accompany the Minimal Corresponding Source and Corresponding Application Code. If you use option 4d1, you must provide the Installation Information in the manner specified by section 6 of the GNU GPL for conveying Corresponding Source.)
 
5. Combined Libraries.
You may place library facilities that are a work based on the Library side by side in a single library together with other library facilities that are not Applications and are not covered by this License, and convey such a combined library under terms of your choice, if you do both of the following:
 
     a) Accompany the combined library with a copy of the same work based on the Library, uncombined with any other library facilities, conveyed under the terms of this License.
 
     b) Give prominent notice with the combined library that part of it is a work based on the Library, and explaining where to find the accompanying uncombined form of the same work.
 
6. Revised Versions of the GNU Lesser General Public License.
The Free Software Foundation may publish revised and/or new versions of the GNU Lesser General Public License from time to time. Such new versions will be similar in spirit to the present version, but may differ in detail to address new problems or concerns.
 
Each version is given a distinguishing version number. If the Library as you received it specifies that a certain numbered version of the GNU Lesser General Public License "or any later version" applies to it, you have the option of following the terms and conditions either of that published version or of any later version published by the Free Software Foundation. If the Library as you received it does not specify a version number of the GNU Lesser General Public License, you may choose any version of the GNU Lesser General Public License ever published by the Free Software Foundation.
 
If the Library as you received it specifies that a proxy can decide whether future versions of the GNU Lesser General Public License shall
apply, that proxy's public statement of acceptance of any version is permanent authorization for you to choose that version for the Library.
 
GNU GENERAL PUBLIC LICENSE
Version 3, 29 June 2007
 
Copyright © 2007 Free Software Foundation, Inc. <http://fsf.org/>
 
Everyone is permitted to copy and distribute verbatim copies of this license document, but changing it is not allowed.
 
Preamble
 
The GNU General Public License is a free, copyleft license for software and other kinds of works.
 
The licenses for most software and other practical works are designed to take away your freedom to share and change the works. By contrast, the GNU General Public License is intended to guarantee your freedom to share and change all versions of a program--to make sure it remains free software for all its users. We, the Free Software Foundation, use the GNU General Public License for most of our software; it applies also to any other work released this way by its authors. You can apply it to your programs, too.
 
When we speak of free software, we are referring to freedom, not price. Our General Public Licenses are designed to make sure that you have the freedom to distribute copies of free software (and charge for them if you wish), that you receive source code or can get it if you want it, that you can change the software or use pieces of it in new free programs, and that you know you can do these things.
 
To protect your rights, we need to prevent others from denying you these rights or asking you to surrender the rights. Therefore, you have certain responsibilities if you distribute copies of the software, or if you modify it: responsibilities to respect the freedom of others.
 
For example, if you distribute copies of such a program, whether gratis or for a fee, you must pass on to the recipients the same freedoms that you received. You must make sure that they, too, receive or can get the source code. And you must show them these terms so they know their rights.
 
Developers that use the GNU GPL protect your rights with two steps: (1) assert copyright on the software, and (2) offer you this License giving you legal permission to copy, distribute and/or modify it.
 
For the developers' and authors' protection, the GPL clearly explains that there is no warranty for this free software. For both users' and authors' sake, the GPL requires that modified versions be marked as changed, so that their problems will not be attributed erroneously to authors of previous versions.
 
Some devices are designed to deny users access to install or run modified versions of the software inside them, although the manufacturer can do so. This is fundamentally incompatible with the aim of protecting users' freedom to change the software. The systematic pattern of such abuse occurs in the area of products for individuals to use, which is precisely where it is most unacceptable. Therefore, we have designed this version of the GPL to prohibit the practice for those products. If such problems arise substantially in other domains, we stand ready to extend this provision to those domains in future versions of the GPL, as needed to protect the freedom of users.
 
Finally, every program is threatened constantly by software patents. States should not allow patents to restrict development and use of software on general-purpose computers, but in those that do, we wish to avoid the special danger that patents applied to a free program could make it effectively proprietary. To prevent this, the GPL assures that patents cannot be used to render the program non-free.
 
The precise terms and conditions for copying, distribution and modification follow.
 
TERMS AND CONDITIONS
 
0. Definitions.
 
“This License” refers to version 3 of the GNU General Public License.
 
“Copyright” also means copyright-like laws that apply to other kinds of works, such as semiconductor masks.
 
“The Program” refers to any copyrightable work licensed under this License. Each licensee is addressed as “you”. “Licensees” and “recipients” may be individuals or organizations.
 
To “modify” a work means to copy from or adapt all or part of the work in a fashion requiring copyright permission, other than the making of an exact copy. The resulting work is called a “modified version” of the earlier work or a work “based on” the earlier work.
 
A “covered work” means either the unmodified Program or a work based on the Program.
 
To “propagate” a work means to do anything with it that, without permission, would make you directly or secondarily liable for infringement under applicable copyright law, except executing it on a computer or modifying a private copy. Propagation includes copying, distribution (with or without modification), making available to the public, and in some countries other activities as well.
 
To “convey” a work means any kind of propagation that enables other parties to make or receive copies. Mere interaction with a user through a computer network, with no transfer of a copy, is not conveying.
 
An interactive user interface displays “Appropriate Legal Notices” to the extent that it includes a convenient and prominently visible feature that (1) displays an appropriate copyright notice, and (2) tells the user that there is no warranty for the work (except to the extent that warranties are provided), that licensees may convey the work under this License, and how to view a copy of this License. If the interface presents a list of user commands or options, such as a menu, a prominent item in the list meets this criterion.
 
1. Source Code.
The “source code” for a work means the preferred form of the work for making modifications to it. “Object code” means any non-source form of a work.
 
A “Standard Interface” means an interface that either is an official standard defined by a recognized standards body, or, in the case of interfaces specified for a particular programming language, one that is widely used among developers working in that language.
 
The “System Libraries” of an executable work include anything, other than the work as a whole, that (a) is included in the normal form of packaging a Major Component, but which is not part of that Major Component, and (b) serves only to enable use of the work with that Major Component, or to implement a Standard Interface for which an implementation is available to the public in source code form. A “Major Component”, in this context, means a major essential component (kernel, window system, and so on) of the specific operating system (if any) on which the executable work runs, or a compiler used to produce the work, or an object code interpreter used to run it.
 
The “Corresponding Source” for a work in object code form means all the source code needed to generate, install, and (for an executable work) run the object code and to modify the work, including scripts to control those activities. However, it does not include the work's System Libraries, or general-purpose tools or generally available free programs which are used unmodified in performing those activities but which are not part of the work. For example, Corresponding Source includes interface definition files associated with source files for the work, and the source code for shared libraries and dynamically linked subprograms that the work is specifically designed to require, such as by intimate data communication or control flow between those subprograms and other parts of the work.
 
The Corresponding Source need not include anything that users can regenerate automatically from other parts of the Corresponding Source.
 
The Corresponding Source for a work in source code form is that same work.
 
2. Basic Permissions.
All rights granted under this License are granted for the term of copyright on the Program, and are irrevocable provided the stated conditions are met. This License explicitly affirms your unlimited permission to run the unmodified Program. The output from running a covered work is covered by this License only if the output, given its content, constitutes a covered work. This License acknowledges your rights of fair use or other equivalent, as provided by copyright law.
 
You may make, run and propagate covered works that you do not convey, without conditions so long as your license otherwise remains in force. You may convey covered works to others for the sole purpose of having them make modifications exclusively for you, or provide you with facilities for running those works, provided that you comply with the terms of this License in conveying all material for which you do not control copyright. Those thus making or running the covered works for you must do so exclusively on your behalf, under your direction and control, on terms that prohibit them from making any copies of your copyrighted material outside their relationship with you.
 
Conveying under any other circumstances is permitted solely under the conditions stated below. Sublicensing is not allowed; section 10 makes it unnecessary.
 
3. Protecting Users' Legal Rights From Anti-Circumvention Law.
No covered work shall be deemed part of an effective technological measure under any applicable law fulfilling obligations under article 11 of the WIPO copyright treaty adopted on 20 December 1996, or similar laws prohibiting or restricting circumvention of such measures.
 
When you convey a covered work, you waive any legal power to forbid circumvention of technological measures to the extent such circumvention is effected by exercising rights under this License with respect to the covered work, and you disclaim any intention to limit operation or modification of the work as a means of enforcing, against the work's users, your or third parties' legal rights to forbid circumvention of technological measures.
 
4. Conveying Verbatim Copies.
You may convey verbatim copies of the Program's source code as you receive it, in any medium, provided that you conspicuously and appropriately publish on each copy an appropriate copyright notice; keep intact all notices stating that this License and any non-permissive terms added in accord with section 7 apply to the code; keep intact all notices of the absence of any warranty; and give all recipients a copy of this License along with the Program.
 
You may charge any price or no price for each copy that you convey, and you may offer support or warranty protection for a fee.
 
5. Conveying Modified Source Versions.
You may convey a work based on the Program, or the modifications to produce it from the Program, in the form of source code under the terms of section 4, provided that you also meet all of these conditions:
 
     a) The work must carry prominent notices stating that you modified it, and giving a relevant date.
 
     b) The work must carry prominent notices stating that it is released under this License and any conditions added under section 7. This requirement modifies the requirement in section 4 to “keep intact all notices”.
 
     c) You must license the entire work, as a whole, under this License to anyone who comes into possession of a copy. This License will therefore apply, along with any applicable section 7 additional terms, to the whole of the work, and all its parts, regardless of how they are packaged. This License gives no permission to license the work in any other way, but it does not invalidate such permission if you have separately received it.
 
     d) If the work has interactive user interfaces, each must display Appropriate Legal Notices; however, if the Program has interactive interfaces that do not display Appropriate Legal Notices, your work need not make them do so.
 
A compilation of a covered work with other separate and independent works, which are not by their nature extensions of the covered work, and which are not combined with it such as to form a larger program, in or on a volume of a storage or distribution medium, is called an “aggregate” if the compilation and its resulting copyright are not used to limit the access or legal rights of the compilation's users beyond what the individual works permit. Inclusion of a covered work in an aggregate does not cause this License to apply to the other parts of the aggregate.
 
6. Conveying Non-Source Forms.
You may convey a covered work in object code form under the terms of sections 4 and 5, provided that you also convey the machine-readable Corresponding Source under the terms of this License, in one of these ways:
 
     a) Convey the object code in, or embodied in, a physical product (including a physical distribution medium), accompanied by the Corresponding Source fixed on a durable physical medium customarily used for software interchange.
 
     b) Convey the object code in, or embodied in, a physical product (including a physical distribution medium), accompanied by a written offer, valid for at least three years and valid for as long as you offer spare parts or customer support for that product model, to give anyone who possesses the object code either (1) a copy of the Corresponding Source for all the software in the product that is covered by this License, on a durable physical medium customarily used for software interchange, for a price no more than your reasonable cost of physically performing this conveying of source, or (2) access to copy the Corresponding Source from a network server at no charge.
 
     c) Convey individual copies of the object code with a copy of the written offer to provide the Corresponding Source. This alternative is allowed only occasionally and noncommercially, and only if you received the object code with such an offer, in accord with subsection 6b.
 
     d) Convey the object code by offering access from a designated place (gratis or for a charge), and offer equivalent access to the Corresponding Source in the same way through the same place at no further charge. You need not require recipients to copy the Corresponding Source along with the object code. If the place to copy the object code is a network server, the Corresponding Source may be on a different server (operated by you or a third party) that supports equivalent copying facilities, provided you maintain clear directions next to the object code saying where to find the Corresponding Source. Regardless of what server hosts the Corresponding Source, you remain obligated to ensure that it is available for as long as needed to satisfy these requirements.
 
     e) Convey the object code using peer-to-peer transmission, provided you inform other peers where the object code and Corresponding Source of the work are being offered to the general public at no charge under subsection 6d.
 
A separable portion of the object code, whose source code is excluded from the Corresponding Source as a System Library, need not be included in conveying the object code work.
 
A “User Product” is either (1) a “consumer product”, which means any tangible personal property which is normally used for personal, family, or household purposes, or (2) anything designed or sold for incorporation into a dwelling. In determining whether a product is a consumer product, doubtful cases shall be resolved in favor of coverage. For a particular product received by a particular user, “normally used” refers to a typical or common use of that class of product, regardless of the status of the particular user or of the way in which the particular user actually uses, or expects or is expected to use, the product. A product is a consumer product regardless of whether the product has substantial commercial, industrial or non-consumer uses, unless such uses represent the only significant mode of use of the product.
 
“Installation Information” for a User Product means any methods, procedures, authorization keys, or other information required to install and execute modified versions of a covered work in that User Product from a modified version of its Corresponding Source. The information must suffice to ensure that the continued functioning of the modified object code is in no case prevented or interfered with solely because modification has been made.
 
If you convey an object code work under this section in, or with, or specifically for use in, a User Product, and the conveying occurs as part of a transaction in which the right of possession and use of the User Product is transferred to the recipient in perpetuity or for a fixed term (regardless of how the transaction is characterized), the Corresponding Source conveyed under this section must be accompanied by the Installation Information. But this requirement does not apply if neither you nor any third party retains the ability to install modified object code on the User Product (for example, the work has been installed in ROM).
 
The requirement to provide Installation Information does not include a requirement to continue to provide support service, warranty, or updates for a work that has been modified or installed by the recipient, or for the User Product in which it has been modified or installed. Access to a network may be denied when the modification itself materially and adversely affects the operation of the network or violates the rules and protocols for communication across the network.
 
Corresponding Source conveyed, and Installation Information provided, in accord with this section must be in a format that is publicly documented (and with an implementation available to the public in source code form), and must require no special password or key for unpacking, reading or copying.
 
7. Additional Terms.
“Additional permissions” are terms that supplement the terms of this License by making exceptions from one or more of its conditions. Additional permissions that are applicable to the entire Program shall be treated as though they were included in this License, to the extent that they are valid under applicable law. If additional permissions apply only to part of the Program, that part may be used separately under those permissions, but the entire Program remains governed by this License without regard to the additional permissions.
 
When you convey a copy of a covered work, you may at your option remove any additional permissions from that copy, or from any part of it. (Additional permissions may be written to require their own removal in certain cases when you modify the work.) You may place additional permissions on material, added by you to a covered work, for which you have or can give appropriate copyright permission.
 
Notwithstanding any other provision of this License, for material you add to a covered work, you may (if authorized by the copyright holders of that material) supplement the terms of this License with terms:
 
     a) Disclaiming warranty or limiting liability differently from the terms of sections 15 and 16 of this License; or
 
     b) Requiring preservation of specified reasonable legal notices or author attributions in that material or in the Appropriate Legal Notices displayed by works containing it; or
 
     c) Prohibiting misrepresentation of the origin of that material, or requiring that modified versions of such material be marked in reasonable ways as different from the original version; or
 
     d) Limiting the use for publicity purposes of names of licensors or authors of the material; or
 
     e) Declining to grant rights under trademark law for use of some trade names, trademarks, or service marks; or
 
     f) Requiring indemnification of licensors and authors of that material by anyone who conveys the material (or modified versions of it) with contractual assumptions of liability to the recipient, for any liability that these contractual assumptions directly impose on those licensors and authors.
 
All other non-permissive additional terms are considered “further restrictions” within the meaning of section 10. If the Program as you received it, or any part of it, contains a notice stating that it is governed by this License along with a term that is a further restriction, you may remove that term. If a license document contains a further restriction but permits relicensing or conveying under this License, you may add to a covered work material governed by the terms of that license document, provided that the further restriction does not survive such relicensing or conveying.
 
If you add terms to a covered work in accord with this section, you must place, in the relevant source files, a statement of the additional terms that apply to those files, or a notice indicating where to find the applicable terms.
 
Additional terms, permissive or non-permissive, may be stated in the form of a separately written license, or stated as exceptions; the above requirements apply either way.
 
8. Termination.
You may not propagate or modify a covered work except as expressly provided under this License. Any attempt otherwise to propagate or modify it is void, and will automatically terminate your rights under this License (including any patent licenses granted under the third paragraph of section 11).
 
However, if you cease all violation of this License, then your license from a particular copyright holder is reinstated (a) provisionally, unless and until the copyright holder explicitly and finally terminates your license, and (b) permanently, if the copyright holder fails to notify you of the violation by some reasonable means prior to 60 days after the cessation.
 
Moreover, your license from a particular copyright holder is reinstated permanently if the copyright holder notifies you of the violation by some reasonable means, this is the first time you have received notice of violation of this License (for any work) from that copyright holder, and you cure the violation prior to 30 days after your receipt of the notice.
 
Termination of your rights under this section does not terminate the licenses of parties who have received copies or rights from you under this License. If your rights have been terminated and not permanently reinstated, you do not qualify to receive new licenses for the same material under section 10.
 
9. Acceptance Not Required for Having Copies.
You are not required to accept this License in order to receive or run a copy of the Program. Ancillary propagation of a covered work occurring solely as a consequence of using peer-to-peer transmission to receive a copy likewise does not require acceptance. However, nothing other than this License grants you permission to propagate or modify any covered work. These actions infringe copyright if you do not accept this License. Therefore, by modifying or propagating a covered work, you indicate your acceptance of this License to do so.
 
10. Automatic Licensing of Downstream Recipients.
Each time you convey a covered work, the recipient automatically receives a license from the original licensors, to run, modify and propagate that work, subject to this License. You are not responsible for enforcing compliance by third parties with this License.
 
An “entity transaction” is a transaction transferring control of an organization, or substantially all assets of one, or subdividing an organization, or merging organizations. If propagation of a covered work results from an entity transaction, each party to that transaction who receives a copy of the work also receives whatever licenses to the work the party's predecessor in interest had or could give under the previous paragraph, plus a right to possession of the Corresponding Source of the work from the predecessor in interest, if the predecessor has it or can get it with reasonable efforts.
 
You may not impose any further restrictions on the exercise of the rights granted or affirmed under this License. For example, you may not impose a license fee, royalty, or other charge for exercise of rights granted under this License, and you may not initiate litigation (including a cross-claim or counterclaim in a lawsuit) alleging that any patent claim is infringed by making, using, selling, offering for sale, or importing the Program or any portion of it.
 
11. Patents.
A “contributor” is a copyright holder who authorizes use under this License of the Program or a work on which the Program is based. The work thus licensed is called the contributor's “contributor version”.
 
A contributor's “essential patent claims” are all patent claims owned or controlled by the contributor, whether already acquired or hereafter acquired, that would be infringed by some manner, permitted by this License, of making, using, or selling its contributor version, but do not include claims that would be infringed only as a consequence of further modification of the contributor version. For purposes of this definition, “control” includes the right to grant patent sublicenses in a manner consistent with the requirements of this License.
 
Each contributor grants you a non-exclusive, worldwide, royalty-free patent license under the contributor's essential patent claims, to make, use, sell, offer for sale, import and otherwise run, modify and propagate the contents of its contributor version.
 
In the following three paragraphs, a “patent license” is any express agreement or commitment, however denominated, not to enforce a patent (such as an express permission to practice a patent or covenant not to sue for patent infringement). To “grant” such a patent license to a party means to make such an agreement or commitment not to enforce a patent against the party.
 
If you convey a covered work, knowingly relying on a patent license, and the Corresponding Source of the work is not available for anyone to copy, free of charge and under the terms of this License, through a publicly available network server or other readily accessible means, then you must either (1) cause the Corresponding Source to be so available, or (2) arrange to deprive yourself of the benefit of the patent license for this particular work, or (3) arrange, in a manner consistent with the requirements of this License, to extend the patent license to downstream recipients. “Knowingly relying” means you have actual knowledge that, but for the patent license, your conveying the covered work in a country, or your recipient's use of the covered work in a country, would infringe one or more identifiable patents in that country that you have reason to believe are valid.
 
If, pursuant to or in connection with a single transaction or arrangement, you convey, or propagate by procuring conveyance of, a covered work, and grant a patent license to some of the parties receiving the covered work authorizing them to use, propagate, modify or convey a specific copy of the covered work, then the patent license you grant is automatically extended to all recipients of the covered work and works based on it.
 
A patent license is “discriminatory” if it does not include within the scope of its coverage, prohibits the exercise of, or is conditioned on the non-exercise of one or more of the rights that are specifically granted under this License. You may not convey a covered work if you are a party to an arrangement with a third party that is in the business of distributing software, under which you make payment to the third party based on the extent of your activity of conveying the work, and under which the third party grants, to any of the parties who would receive the covered work from you, a discriminatory patent license (a) in connection with copies of the covered work conveyed by you (or copies made from those copies), or (b) primarily for and in connection with specific products or compilations that contain the covered work, unless you entered into that arrangement, or that patent license was granted, prior to 28 March 2007.
 
Nothing in this License shall be construed as excluding or limiting any implied license or other defenses to infringement that may otherwise be available to you under applicable patent law.
 
12. No Surrender of Others' Freedom.
If conditions are imposed on you (whether by court order, agreement or otherwise) that contradict the conditions of this License, they do not excuse you from the conditions of this License. If you cannot convey a covered work so as to satisfy simultaneously your obligations under this License and any other pertinent obligations, then as a consequence you may not convey it at all. For example, if you agree to terms that obligate you to collect a royalty for further conveying from those to whom you convey the Program, the only way you could satisfy both those terms and this License would be to refrain entirely from conveying the Program.
 
13. Use with the GNU Affero General Public License.
Notwithstanding any other provision of this License, you have permission to link or combine any covered work with a work licensed under version 3 of the GNU Affero General Public License into a single combined work, and to convey the resulting work. The terms of this License will continue to apply to the part which is the covered work, but the special requirements of the GNU Affero General Public License, section 13, concerning interaction through a network will apply to the combination as such.
 
14. Revised Versions of this License.
The Free Software Foundation may publish revised and/or new versions of the GNU General Public License from time to time. Such new versions will be similar in spirit to the present version, but may differ in detail to address new problems or concerns.
 
Each version is given a distinguishing version number. If the Program specifies that a certain numbered version of the GNU General Public License “or any later version” applies to it, you have the option of following the terms and conditions either of that numbered version or of any later version published by the Free Software Foundation. If the Program does not specify a version number of the GNU General Public License, you may choose any version ever published by the Free Software Foundation.
 
If the Program specifies that a proxy can decide which future versions of the GNU General Public License can be used, that proxy's public statement of acceptance of a version permanently authorizes you to choose that version for the Program.
 
Later license versions may give you additional or different permissions. However, no additional obligations are imposed on any author or copyright holder as a result of your choosing to follow a later version.
 
15. Disclaimer of Warranty.
THERE IS NO WARRANTY FOR THE PROGRAM, TO THE EXTENT PERMITTED BY APPLICABLE LAW. EXCEPT WHEN OTHERWISE STATED IN WRITING THE COPYRIGHT HOLDERS AND/OR OTHER PARTIES PROVIDE THE PROGRAM “AS IS” WITHOUT WARRANTY OF ANY KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE. THE ENTIRE RISK AS TO THE QUALITY AND PERFORMANCE OF THE PROGRAM IS WITH YOU. SHOULD THE PROGRAM PROVE DEFECTIVE, YOU ASSUME THE COST OF ALL NECESSARY SERVICING, REPAIR OR CORRECTION.
 
16. Limitation of Liability.
IN NO EVENT UNLESS REQUIRED BY APPLICABLE LAW OR AGREED TO IN WRITING WILL ANY COPYRIGHT HOLDER, OR ANY OTHER PARTY WHO MODIFIES AND/OR CONVEYS THE PROGRAM AS PERMITTED ABOVE, BE LIABLE TO YOU FOR DAMAGES, INCLUDING ANY GENERAL, SPECIAL, INCIDENTAL OR CONSEQUENTIAL DAMAGES ARISING OUT OF THE USE OR INABILITY TO USE THE PROGRAM (INCLUDING BUT NOT LIMITED TO LOSS OF DATA OR DATA BEING RENDERED INACCURATE OR LOSSES SUSTAINED BY YOU OR THIRD PARTIES OR A FAILURE OF THE PROGRAM TO OPERATE WITH ANY OTHER PROGRAMS), EVEN IF SUCH HOLDER OR OTHER PARTY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
 
17. Interpretation of Sections 15 and 16.
If the disclaimer of warranty and limitation of liability provided above cannot be given local legal effect according to their terms, reviewing courts shall apply local law that most closely approximates an absolute waiver of all civil liability in connection with the Program, unless a warranty or assumption of liability accompanies a copy of the Program in return for a fee.
 
END OF TERMS AND CONDITIONS
 
How to Apply These Terms to Your New Programs
 
If you develop a new program, and you want it to be of the greatest possible use to the public, the best way to achieve this is to make it free software which everyone can redistribute and change under these terms.
 
To do so, attach the following notices to the program. It is safest to attach them to the start of each source file to most effectively state the exclusion of warranty; and each file should have at least the “copyright” line and a pointer to where the full notice is found.
 
     <one line to give the program's name and a brief idea of what it does.>
     Copyright (C) <year>  <name of author>
 
     This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
 
     This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License for more details.
 
     You should have received a copy of the GNU General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.
 
Also add information on how to contact you by electronic and paper mail.
 
If the program does terminal interaction, make it output a short notice like this when it starts in an interactive mode:
 
     <program>  Copyright (C) <year>  <name of author>
     This program comes with ABSOLUTELY NO WARRANTY; for details type `show w'.
     This is free software, and you are welcome to redistribute it under certain conditions; type `show c' for details.
 
The hypothetical commands `show w' and `show c' should show the appropriate parts of the General Public License. Of course, your program's commands might be different; for a GUI interface, you would use an “about box”.
 
You should also get your employer (if you work as a programmer) or school, if any, to sign a “copyright disclaimer” for the program, if necessary. For more information on this, and how to apply and follow the GNU GPL, see <http://www.gnu.org/licenses/>.
 
The GNU General Public License does not permit incorporating your program into proprietary programs. If your program is a subroutine library, you may consider it more useful to permit linking proprietary applications with the library. If this is what you want to do, use the GNU Lesser General Public License instead of this License. But first, please read <http://www.gnu.org/philosophy/why-not-lgpl.html>.
```
 
