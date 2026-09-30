/**
 * High-performance, zero-dependency Markdown renderer tailored for
 * Stallion Permission Intelligence & Regulatory Compliance chat.
 *
 * Supports:
 * - Headings (#, ##, ###, ####)
 * - Bold, italic, strikethrough
 * - Blockquotes (styled for reminders & sanction conditions)
 * - Tables with glassmorphism styling
 * - Ordered & unordered lists
 * - Inline code & fenced code blocks
 * - Clickable links (e.g. S3 PDF ai_view_urls)
 * - Automatic status badges (COMPLIED, APPROVED, PENDING, CRITICAL BLOCKER)
 */

export function renderMarkdown(markdown: string): string {
  if (!markdown) return '';

  // 1. Sanitize raw HTML tags to prevent XSS while preserving formatting
  let html = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. Fenced code blocks ```lang ... ```
  html = html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre class="chat-code-block"><code>${code.trim()}</code></pre>`;
  });

  // 3. Inline code `code`
  html = html.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');

  // 4. Tables (| col1 | col2 |)
  html = renderTables(html);

  // 5. Blockquotes (> text)
  html = html.replace(/^(?:&gt;|>)[ ]?(.*)$/gm, '<blockquote class="chat-quote">$1</blockquote>');
  // Combine consecutive blockquotes
  html = html.replace(/<\/blockquote>\s*<blockquote class="chat-quote">/g, '<br/>');

  // 6. Headings (#, ##, ###, ####)
  html = html.replace(/^#### (.*$)/gim, '<h5 class="chat-h5">$1</h5>');
  html = html.replace(/^### (.*$)/gim, '<h4 class="chat-h4">$1</h4>');
  html = html.replace(/^## (.*$)/gim, '<h3 class="chat-h3">$1</h3>');
  html = html.replace(/^# (.*$)/gim, '<h2 class="chat-h2">$1</h2>');

  // 7. Bold and Italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

  // 8. Markdown Links [Text](URL)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="chat-link">$1 <span class="link-arrow">↗</span></a>');

  // 9. Unordered Lists (*, -)
  html = html.replace(/^[\*\-][ ]+(.*)$/gim, '<li class="chat-list-item">$1</li>');
  html = html.replace(/(<li class="chat-list-item">.*<\/li>\s*)+/g, '<ul class="chat-ul">$&</ul>');

  // 10. Ordered Lists (1., 2.)
  html = html.replace(/^\d+\.[ ]+(.*)$/gim, '<li class="chat-list-item-num">$1</li>');
  html = html.replace(/(<li class="chat-list-item-num">.*<\/li>\s*)+/g, '<ol class="chat-ol">$&</ol>');

  // 11. Automatic Status Badges
  html = applyStatusBadges(html);

  // 12. Paragraphs & Line Breaks
  // Replace double newlines with paragraph separators
  const sections = html.split(/\n{2,}/);
  const formattedSections = sections.map((sec) => {
    sec = sec.trim();
    if (!sec) return '';
    if (
      sec.startsWith('<h') ||
      sec.startsWith('<ul') ||
      sec.startsWith('<ol') ||
      sec.startsWith('<table') ||
      sec.startsWith('<pre') ||
      sec.startsWith('<blockquote')
    ) {
      return sec;
    }
    // Replace single newlines within paragraphs with <br/>
    return `<p class="chat-p">${sec.replace(/\n/g, '<br/>')}</p>`;
  });

  return formattedSections.join('\n');
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
      tableHtml += `<th>${h}</th>`;
    }
    tableHtml += '</tr></thead><tbody>';

    for (let i = bodyStartIndex; i < lines.length; i++) {
      const cells = parseRow(lines[i]);
      tableHtml += '<tr>';
      for (const c of cells) {
        tableHtml += `<td>${c}</td>`;
      }
      tableHtml += '</tr>';
    }

    tableHtml += '</tbody></table></div>';
    return tableHtml;
  });
}

/**
 * Automatically detects compliance and regulatory terms and converts them to styled pills
 */
function applyStatusBadges(html: string): string {
  return html
    .replace(/\b(COMPLIED|SATISFIED|APPROVED|ISSUED|SANCTIONED)\b/g, '<span class="status-pill-badge badge-approved">$1</span>')
    .replace(/\b(CRITICAL BLOCKER|BLOCKER|CRITICAL|EXPIRED|REJECTED)\b/g, '<span class="status-pill-badge badge-blocker">$1</span>')
    .replace(/\b(PENDING|IN PROGRESS|UNDER SCRUTINY|AWAITING APPROVAL)\b/g, '<span class="status-pill-badge badge-pending">$1</span>');
}
