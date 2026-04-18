const TELEGRAM_CHUNK_LIMIT = 3500;
const SAFE_TEXT_BLOCK_LIMIT = 3000;
const SAFE_CODE_BLOCK_LIMIT = 3200;

function cleanText(value) {
  return String(value ?? "").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttr(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function parseTextBlocks(text) {
  return cleanText(text)
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => ({
      type: "text",
      text: item,
    }));
}

function parseBlocks(text) {
  const normalized = cleanText(text).replace(/\r\n/g, "\n");
  if (!normalized) {
    return [];
  }

  const blocks = [];
  const codeFencePattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match;
  while ((match = codeFencePattern.exec(normalized)) !== null) {
    const before = normalized.slice(cursor, match.index);
    blocks.push(...parseTextBlocks(before));
    blocks.push({
      type: "code",
      language: cleanText(match[1]),
      text: String(match[2] ?? "").replace(/\n$/, ""),
    });
    cursor = codeFencePattern.lastIndex;
  }

  blocks.push(...parseTextBlocks(normalized.slice(cursor)));
  return blocks;
}

function splitTextByLength(text, limit) {
  const chunks = [];
  let remaining = String(text ?? "");
  while (remaining.length > limit) {
    let sliceAt = remaining.lastIndexOf("\n", limit);
    if (sliceAt < Math.floor(limit * 0.5)) {
      sliceAt = remaining.lastIndexOf(" ", limit);
    }
    if (sliceAt < Math.floor(limit * 0.5)) {
      sliceAt = limit;
    }
    chunks.push(remaining.slice(0, sliceAt).trim());
    remaining = remaining.slice(sliceAt).trim();
  }
  if (remaining.trim()) {
    chunks.push(remaining.trim());
  }
  return chunks;
}

function splitCodeByLength(text, limit) {
  const lines = String(text ?? "").split("\n");
  const chunks = [];
  let current = "";

  function flush() {
    if (current) {
      chunks.push(current);
      current = "";
    }
  }

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    flush();
    if (line.length <= limit) {
      current = line;
      continue;
    }
    for (const piece of splitTextByLength(line, limit)) {
      chunks.push(piece);
    }
  }

  flush();
  return chunks.filter(Boolean);
}

function expandBlocksForLimit(blocks) {
  const expanded = [];
  for (const block of blocks) {
    if (block.type === "code") {
      if (block.text.length <= SAFE_CODE_BLOCK_LIMIT) {
        expanded.push(block);
        continue;
      }
      for (const piece of splitCodeByLength(block.text, SAFE_CODE_BLOCK_LIMIT)) {
        expanded.push({
          ...block,
          text: piece,
        });
      }
      continue;
    }

    if (block.text.length <= SAFE_TEXT_BLOCK_LIMIT) {
      expanded.push(block);
      continue;
    }
    for (const piece of splitTextByLength(block.text, SAFE_TEXT_BLOCK_LIMIT)) {
      expanded.push({
        ...block,
        text: piece,
      });
    }
  }
  return expanded;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value ?? "").trim());
}

function findNextSpecial(text, start) {
  const candidates = ["**", "*", "~~", "||", "_", "`", "[", "http://", "https://"]
    .map((needle) => text.indexOf(needle, start))
    .filter((index) => index >= 0);
  if (candidates.length === 0) {
    return -1;
  }
  return Math.min(...candidates);
}

function isItalicDelimiterAt(text, index) {
  if (text[index] !== "_") {
    return false;
  }
  if (text[index + 1] === "_" || text[index - 1] === "_") {
    return false;
  }
  const before = text[index - 1] || "";
  const after = text[index + 1] || "";
  return !/[A-Za-zА-Яа-я0-9]/.test(before) && after.trim() !== "";
}

function findItalicEnd(text, start) {
  let cursor = start;
  while ((cursor = text.indexOf("_", cursor)) >= 0) {
    const before = text[cursor - 1] || "";
    const after = text[cursor + 1] || "";
    if (before.trim() && !/[A-Za-zА-Яа-я0-9]/.test(after)) {
      return cursor;
    }
    cursor += 1;
  }
  return -1;
}

function isStarItalicDelimiterAt(text, index) {
  if (text[index] !== "*") {
    return false;
  }
  if (text[index + 1] === "*" || text[index - 1] === "*") {
    return false;
  }
  const before = text[index - 1] || "";
  const after = text[index + 1] || "";
  return !/[A-Za-zА-Яа-я0-9]/.test(before) && after.trim() !== "";
}

function findStarItalicEnd(text, start) {
  let cursor = start;
  while ((cursor = text.indexOf("*", cursor)) >= 0) {
    const before = text[cursor - 1] || "";
    const after = text[cursor + 1] || "";
    if (
      text[cursor - 1] !== "*"
      && text[cursor + 1] !== "*"
      && before.trim()
      && !/[A-Za-zА-Яа-я0-9]/.test(after)
    ) {
      return cursor;
    }
    cursor += 1;
  }
  return -1;
}

function consumeBareUrl(text, index) {
  const match = String(text ?? "").slice(index).match(/^https?:\/\/[^\s<>"']+/i);
  if (!match) {
    return null;
  }
  let url = match[0];
  while (/[.,;:!?)]$/.test(url)) {
    url = url.slice(0, -1);
  }
  if (!isHttpUrl(url)) {
    return null;
  }
  return {
    url,
    end: index + url.length,
  };
}

function renderLinkPlain(label, target) {
  if (isHttpUrl(target)) {
    return `${label} (${target})`;
  }
  return label || target;
}

function renderInlinePlain(text) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("**", index)) {
      const end = text.indexOf("**", index + 2);
      if (end > index + 2) {
        out += renderInlinePlain(text.slice(index + 2, end));
        index = end + 2;
        continue;
      }
    }

    if (text.startsWith("~~", index)) {
      const end = text.indexOf("~~", index + 2);
      if (end > index + 2) {
        out += renderInlinePlain(text.slice(index + 2, end));
        index = end + 2;
        continue;
      }
    }

    if (isStarItalicDelimiterAt(text, index)) {
      const end = findStarItalicEnd(text, index + 1);
      if (end > index + 1) {
        out += renderInlinePlain(text.slice(index + 1, end));
        index = end + 1;
        continue;
      }
    }

    if (text.startsWith("||", index)) {
      const end = text.indexOf("||", index + 2);
      if (end > index + 2) {
        out += renderInlinePlain(text.slice(index + 2, end));
        index = end + 2;
        continue;
      }
    }

    if (isItalicDelimiterAt(text, index)) {
      const end = findItalicEnd(text, index + 1);
      if (end > index + 1) {
        out += renderInlinePlain(text.slice(index + 1, end));
        index = end + 1;
        continue;
      }
    }

    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        out += text.slice(index + 1, end);
        index = end + 1;
        continue;
      }
    }

    if (text[index] === "[") {
      const labelEnd = text.indexOf("]", index + 1);
      if (labelEnd > index + 1 && text[labelEnd + 1] === "(") {
        const targetEnd = text.indexOf(")", labelEnd + 2);
        if (targetEnd > labelEnd + 2) {
          const label = renderInlinePlain(text.slice(index + 1, labelEnd));
          const target = text.slice(labelEnd + 2, targetEnd);
          out += renderLinkPlain(label, target);
          index = targetEnd + 1;
          continue;
        }
      }
    }

    const bareUrl = consumeBareUrl(text, index);
    if (bareUrl) {
      out += bareUrl.url;
      index = bareUrl.end;
      continue;
    }

    const nextSpecial = findNextSpecial(text, index);
    if (nextSpecial === -1) {
      out += text.slice(index);
      break;
    }
    if (nextSpecial <= index) {
      out += text[index];
      index += 1;
      continue;
    }
    out += text.slice(index, nextSpecial);
    index = nextSpecial;
  }
  return out;
}

function renderInlineHtml(text) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("**", index)) {
      const end = text.indexOf("**", index + 2);
      if (end > index + 2) {
        out += `<b>${renderInlineHtml(text.slice(index + 2, end))}</b>`;
        index = end + 2;
        continue;
      }
    }

    if (text.startsWith("~~", index)) {
      const end = text.indexOf("~~", index + 2);
      if (end > index + 2) {
        out += `<s>${renderInlineHtml(text.slice(index + 2, end))}</s>`;
        index = end + 2;
        continue;
      }
    }

    if (isStarItalicDelimiterAt(text, index)) {
      const end = findStarItalicEnd(text, index + 1);
      if (end > index + 1) {
        out += `<i>${renderInlineHtml(text.slice(index + 1, end))}</i>`;
        index = end + 1;
        continue;
      }
    }

    if (text.startsWith("||", index)) {
      const end = text.indexOf("||", index + 2);
      if (end > index + 2) {
        out += `<tg-spoiler>${renderInlineHtml(text.slice(index + 2, end))}</tg-spoiler>`;
        index = end + 2;
        continue;
      }
    }

    if (isItalicDelimiterAt(text, index)) {
      const end = findItalicEnd(text, index + 1);
      if (end > index + 1) {
        out += `<i>${renderInlineHtml(text.slice(index + 1, end))}</i>`;
        index = end + 1;
        continue;
      }
    }

    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        out += `<code>${escapeHtml(text.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }

    if (text[index] === "[") {
      const labelEnd = text.indexOf("]", index + 1);
      if (labelEnd > index + 1 && text[labelEnd + 1] === "(") {
        const targetEnd = text.indexOf(")", labelEnd + 2);
        if (targetEnd > labelEnd + 2) {
          const labelRaw = text.slice(index + 1, labelEnd);
          const target = text.slice(labelEnd + 2, targetEnd).trim();
          if (isHttpUrl(target)) {
            out += `<a href="${escapeHtmlAttr(target)}">${escapeHtml(renderInlinePlain(labelRaw))}</a>`;
          } else {
            out += renderInlineHtml(labelRaw);
          }
          index = targetEnd + 1;
          continue;
        }
      }
    }

    const bareUrl = consumeBareUrl(text, index);
    if (bareUrl) {
      out += `<a href="${escapeHtmlAttr(bareUrl.url)}">${escapeHtml(bareUrl.url)}</a>`;
      index = bareUrl.end;
      continue;
    }

    const nextSpecial = findNextSpecial(text, index);
    if (nextSpecial === -1) {
      out += escapeHtml(text.slice(index));
      break;
    }
    if (nextSpecial <= index) {
      out += escapeHtml(text[index]);
      index += 1;
      continue;
    }
    out += escapeHtml(text.slice(index, nextSpecial));
    index = nextSpecial;
  }
  return out;
}

function renderLineIndent(value) {
  return String(value ?? "").replace(/\t/g, "  ");
}

function renderTextLineHtml(line) {
  const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
  if (headingMatch) {
    return `<b>${renderInlineHtml(headingMatch[1])}</b>`;
  }

  const taskMatch = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.+)$/);
  if (taskMatch) {
    const checkbox = taskMatch[2].toLowerCase() === "x" ? "☑" : "☐";
    return `${renderLineIndent(taskMatch[1])}${checkbox} ${renderInlineHtml(taskMatch[3])}`;
  }

  const bulletMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
  if (bulletMatch) {
    return `${renderLineIndent(bulletMatch[1])}• ${renderInlineHtml(bulletMatch[2])}`;
  }

  const numberedMatch = line.match(/^(\s*)(\d+[.)])\s+(.+)$/);
  if (numberedMatch) {
    return `${renderLineIndent(numberedMatch[1])}<b>${escapeHtml(numberedMatch[2])}</b> ${renderInlineHtml(numberedMatch[3])}`;
  }

  return renderInlineHtml(line);
}

function renderTextLinePlain(line) {
  const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
  if (headingMatch) {
    return renderInlinePlain(headingMatch[1]);
  }

  const taskMatch = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.+)$/);
  if (taskMatch) {
    const checkbox = taskMatch[2].toLowerCase() === "x" ? "☑" : "☐";
    return `${renderLineIndent(taskMatch[1])}${checkbox} ${renderInlinePlain(taskMatch[3])}`;
  }

  const bulletMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
  if (bulletMatch) {
    return `${renderLineIndent(bulletMatch[1])}• ${renderInlinePlain(bulletMatch[2])}`;
  }

  const numberedMatch = line.match(/^(\s*)(\d+[.)])\s+(.+)$/);
  if (numberedMatch) {
    return `${renderLineIndent(numberedMatch[1])}${numberedMatch[2]} ${renderInlinePlain(numberedMatch[3])}`;
  }

  return renderInlinePlain(line);
}

function renderTextBlock(block) {
  const htmlLines = [];
  const plainLines = [];
  let quoteHtml = [];
  let quotePlain = [];

  function flushQuote() {
    if (!quoteHtml.length) {
      return;
    }
    htmlLines.push(`<blockquote>${quoteHtml.join("\n")}</blockquote>`);
    plainLines.push(quotePlain.map((line) => `> ${line}`.trimEnd()).join("\n"));
    quoteHtml = [];
    quotePlain = [];
  }

  for (const line of String(block.text ?? "").split("\n")) {
    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      quoteHtml.push(renderInlineHtml(quoteMatch[1]));
      quotePlain.push(renderInlinePlain(quoteMatch[1]));
      continue;
    }

    flushQuote();
    htmlLines.push(renderTextLineHtml(line));
    plainLines.push(renderTextLinePlain(line));
  }

  flushQuote();
  return {
    html: htmlLines.join("\n"),
    plain: plainLines.join("\n"),
  };
}

function renderBlock(block) {
  if (block.type === "code") {
    const codeText = block.text || "";
    const language = cleanText(block.language).replace(/[^A-Za-z0-9_+-]/g, "").slice(0, 32);
    return {
      html: language
        ? `<pre><code class="language-${escapeHtmlAttr(language)}">${escapeHtml(codeText)}</code></pre>`
        : `<pre>${escapeHtml(codeText)}</pre>`,
      plain: codeText,
    };
  }

  return renderTextBlock(block);
}

export function renderTelegramChunks(text, limit = TELEGRAM_CHUNK_LIMIT) {
  const blocks = expandBlocksForLimit(parseBlocks(text));
  if (blocks.length === 0) {
    return [{ html: "", plain: "" }];
  }

  const renderedBlocks = blocks.map(renderBlock);
  const chunks = [];
  let current = null;

  function flush() {
    if (current) {
      chunks.push(current);
      current = null;
    }
  }

  for (const block of renderedBlocks) {
    if (!current) {
      current = {
        html: block.html,
        plain: block.plain,
      };
      continue;
    }

    const candidateHtml = `${current.html}\n\n${block.html}`;
    const candidatePlain = `${current.plain}\n\n${block.plain}`;
    if (candidateHtml.length <= limit) {
      current = {
        html: candidateHtml,
        plain: candidatePlain,
      };
      continue;
    }

    flush();
    current = {
      html: block.html,
      plain: block.plain,
    };
  }

  flush();
  return chunks;
}

export function renderTelegramPlainText(text) {
  return renderTelegramChunks(text)
    .map((chunk) => chunk.plain)
    .join("\n\n");
}
