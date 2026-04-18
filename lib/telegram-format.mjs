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
  const candidates = ["**", "`", "["]
    .map((needle) => text.indexOf(needle, start))
    .filter((index) => index >= 0);
  if (candidates.length === 0) {
    return -1;
  }
  return Math.min(...candidates);
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

    const nextSpecial = findNextSpecial(text, index);
    if (nextSpecial === -1) {
      out += text.slice(index);
      break;
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
          const target = text.slice(labelEnd + 2, targetEnd);
          if (isHttpUrl(target)) {
            out += `<a href="${escapeHtml(target)}">${escapeHtml(renderInlinePlain(labelRaw))}</a>`;
          } else {
            out += renderInlineHtml(labelRaw);
          }
          index = targetEnd + 1;
          continue;
        }
      }
    }

    const nextSpecial = findNextSpecial(text, index);
    if (nextSpecial === -1) {
      out += escapeHtml(text.slice(index));
      break;
    }
    out += escapeHtml(text.slice(index, nextSpecial));
    index = nextSpecial;
  }
  return out;
}

function renderTextLineHtml(line) {
  const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
  if (headingMatch) {
    return `<b>${renderInlineHtml(headingMatch[1])}</b>`;
  }
  return renderInlineHtml(line);
}

function renderBlock(block) {
  if (block.type === "code") {
    const codeText = block.text || "";
    return {
      html: `<pre>${escapeHtml(codeText)}</pre>`,
      plain: codeText,
    };
  }

  const lines = String(block.text ?? "").split("\n");
  return {
    html: lines.map((line) => renderTextLineHtml(line)).join("\n"),
    plain: lines.map((line) => renderInlinePlain(line)).join("\n"),
  };
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
