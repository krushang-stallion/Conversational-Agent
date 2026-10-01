/**
 * High-performance, zero-dependency Markdown renderer tailored for
 * Stallion Permission Intelligence & Regulatory Compliance chat.
 *
 * Supports:
 * - Headings (#, ##, ###, ####, #####)
 * - Bold, italic, strikethrough
 * - Blockquotes (styled for reminders & sanction conditions)
 * - Tables with glassmorphism styling
 * - Ordered lists (1., 2., ...) with correct sequential numbering
 * - Nested unordered sub-bullets inside ordered lists
 * - Unordered lists (*, -, +) with nested sub-bullets
 * - Inline code & fenced code blocks
 * - Clickable links (e.g. S3 PDF ai_view_urls)
 * - Automatic status badges (COMPLIED, APPROVED, PENDING, CRITICAL BLOCKER)
 */

export function renderMarkdown(markdown: string): string {
  if (!markdown) return '';

  // 1. Extract fenced code blocks first to protect code content
  const codeBlocks: string[] = [];
  let text = markdown.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="chat-code-block"><code>${code.trim()}</code></pre>`);
    return `___CODE_BLOCK_${idx}___`;
  });

  // 2. Extract tables into placeholders to avoid line collision
  const tableBlocks: string[] = [];
  text = renderTables(text);
  text = text.replace(/<div class="table-responsive">[\s\S]*?<\/div>/g, (match) => {
    const idx = tableBlocks.length;
    tableBlocks.push(match);
    return `___TABLE_BLOCK_${idx}___`;
  });

  const lines = text.split(/\r?\n/);
  const output: string[] = [];

  let inOrderedList = false;
  let inUnorderedList = false;
  let inSubList = false;
  let inBlockquote = false;
  let blockquoteLines: string[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      output.push(`<p class="chat-p">${paragraphLines.join('<br/>')}</p>`);
      paragraphLines = [];
    }
  };

  const closeSubList = () => {
    if (inSubList) {
      output.push('</ul>');
      inSubList = false;
    }
  };

  const closeLists = () => {
    closeSubList();
    if (inOrderedList) {
      output.push('</li></ol>');
      inOrderedList = false;
    }
    if (inUnorderedList) {
      output.push('</li></ul>');
      inUnorderedList = false;
    }
  };

  const closeBlockquote = () => {
    if (inBlockquote) {
      output.push(`<blockquote class="chat-quote">${blockquoteLines.join('<br/>')}</blockquote>`);
      blockquoteLines = [];
      inBlockquote = false;
    }
  };

  const getNextNonEmptyLine = (currIndex: number): string | null => {
    for (let j = currIndex + 1; j < lines.length; j++) {
      const trimmedLine = lines[j].trim();
      if (trimmedLine) return trimmedLine;
    }
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Check code block placeholder
    if (trimmed.startsWith('___CODE_BLOCK_') && trimmed.endsWith('___')) {
      flushParagraph();
      closeBlockquote();
      closeLists();
      const idx = parseInt(trimmed.replace('___CODE_BLOCK_', '').replace('___', ''), 10);
      output.push(codeBlocks[idx]);
      continue;
    }

    // Check table placeholder
    if (trimmed.startsWith('___TABLE_BLOCK_') && trimmed.endsWith('___')) {
      flushParagraph();
      closeBlockquote();
      closeLists();
      const idx = parseInt(trimmed.replace('___TABLE_BLOCK_', '').replace('___', ''), 10);
      output.push(tableBlocks[idx]);
      continue;
    }

    // Empty line
    if (!trimmed) {
      flushParagraph();
      closeBlockquote();
      closeSubList();

      // Check if following non-empty line continues current list
      const next = getNextNonEmptyLine(i);
      if (inOrderedList && next && /^\d+[\.\)]\s+/.test(next)) {
        // Keep inOrderedList open for loose lists
        continue;
      }
      if (inUnorderedList && next && /^[-*+]\s+/.test(next)) {
        // Keep inUnorderedList open for loose lists
        continue;
      }

      closeLists();
      continue;
    }

    // Blockquote (> text)
    if (trimmed.startsWith('>')) {
      flushParagraph();
      closeLists();
      inBlockquote = true;
      blockquoteLines.push(renderInline(trimmed.replace(/^>[ ]?/, '')));
      continue;
    } else {
      closeBlockquote();
    }

    // Heading (#, ##, ###, ####, #####)
    const headingMatch = trimmed.match(/^(#{1,5})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      closeLists();
      const level = headingMatch[1].length;
      const hTag = `h${Math.min(level + 1, 5)}`;
      output.push(`<${hTag} class="chat-${hTag}">${renderInline(headingMatch[2])}</${hTag}>`);
      continue;
    }

    // Ordered list item: e.g. "1. Structural Compliance:" or "1) Item"
    const orderedMatch = trimmed.match(/^(\d+)[\.\)]\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      closeSubList();
      if (!inOrderedList) {
        closeLists();
        inOrderedList = true;
        output.push('<ol class="chat-ol">');
      } else {
        output.push('</li>');
      }
      output.push(`<li class="chat-list-item-num"><span class="chat-list-heading">${renderInline(orderedMatch[2])}</span>`);
      continue;
    }

    // Unordered list item or sub-bullet: e.g. "- Submit...", "* Item"
    const isIndentedBullet = /^\s{2,}[-*+]\s+/.test(rawLine);
    const unorderedMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      flushParagraph();
      if (inOrderedList || (inUnorderedList && isIndentedBullet)) {
        // Nested sub-bullet
        if (!inSubList) {
          inSubList = true;
          output.push('<ul class="chat-ul">');
        }
        output.push(`<li class="chat-list-item">${renderInline(unorderedMatch[1])}</li>`);
      } else {
        closeSubList();
        if (!inUnorderedList) {
          closeLists();
          inUnorderedList = true;
          output.push('<ul class="chat-ul">');
        } else {
          output.push('</li>');
        }
        output.push(`<li class="chat-list-item">${renderInline(unorderedMatch[1])}`);
      }
      continue;
    }

    // Regular paragraph line
    closeLists();
    paragraphLines.push(renderInline(trimmed));
  }

  flushParagraph();
  closeBlockquote();
  closeLists();

  return output.join('\n');
}

/**
 * Render inline markdown elements:
 * bold, italic, strikethrough, inline code, links, status badges
 */
function renderInline(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="chat-link">$1 <span class="link-arrow">↗</span></a>')
    .replace(/\b(COMPLIED|SATISFIED|APPROVED|ISSUED|SANCTIONED)\b/g, '<span class="status-pill-badge badge-approved">$1</span>')
    .replace(/\b(CRITICAL BLOCKER|BLOCKER|CRITICAL|EXPIRED|REJECTED)\b/g, '<span class="status-pill-badge badge-blocker">$1</span>')
    .replace(/\b(PENDING|IN PROGRESS|UNDER SCRUTINY|AWAITING APPROVAL)\b/g, '<span class="status-pill-badge badge-pending">$1</span>');
}

/**
 * Render Markdown Tables (| Header | Header | \n | --- | --- | \n | Cell | Cell |)
 */
function renderTables(text: string): string {
  const tableRegex = /((?:\|[^\n]+\|\r?\n)+)/g;

  return text.replace(tableRegex, (match) => {
    const lines = match.trim().split(/\r?\n/).filter(l => l.trim().startsWith('|'));
    if (lines.length < 2) return match;

    const parseRow = (line: string) => {
      return line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(cell => cell.trim());
    };

    const headerCells = parseRow(lines[0]);
    let bodyStartIndex = 1;

    // Check if second line is divider (e.g. |---|---|)
    if (lines.length > 1 && /^\|?(\s*:?-+:?\s*\|)+\s*$/.test(lines[1])) {
      bodyStartIndex = 2;
    }

    let tableHtml = '<div class="table-responsive"><table class="chat-table"><thead><tr>';
    for (const h of headerCells) {
      tableHtml += `<th>${renderInline(h)}</th>`;
    }
    tableHtml += '</tr></thead><tbody>';

    for (let i = bodyStartIndex; i < lines.length; i++) {
      const cells = parseRow(lines[i]);
      tableHtml += '<tr>';
      for (const c of cells) {
        tableHtml += `<td>${renderInline(c)}</td>`;
      }
      tableHtml += '</tr>';
    }

    tableHtml += '</tbody></table></div>';
    return tableHtml;
  });
}
