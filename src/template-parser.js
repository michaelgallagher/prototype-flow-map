const fs = require("fs");
const path = require("path");
const { fileToUrlPath } = require("./scanner");

/**
 * Parse a single Nunjucks template file and extract:
 * - page metadata (title, extends, hub)
 * - outgoing links (href attributes)
 * - form actions
 * - conditional branches ({% if %} blocks wrapping links/forms)
 * - JS redirects (location.href)
 * - back link URLs
 */
function parseTemplate(filePath, prototypePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const urlPath = fileToUrlPath(filePath, prototypePath);

  // Skip layout files, includes, and component partials
  const relativePath = path.relative(
    path.join(prototypePath, "app", "views"),
    filePath,
  );

  // Skip layouts (layout.html, layouts/*, layout-*.html)
  if (relativePath.startsWith("layout")) return null;

  // Skip includes
  if (relativePath.startsWith("includes/")) return null;

  // Skip component partials, but allow components/index.html
  if (
    relativePath.startsWith("components/") &&
    relativePath !== "components/index.html"
  ) {
    return null;
  }

  const result = {
    filePath,
    urlPath,
    relativePath,
    pageTitle: extractPageTitle(content),
    hub: extractVariable(content, "hub"),
    extendsLayout: extractExtends(content),
    links: [],
    formActions: [],
    conditionalLinks: [],
    jsRedirects: [],
    backLink: extractBackLink(content),
  };

  // Extract all links and form actions, with conditional context
  extractLinksAndForms(content, result);

  // Extract JS-based redirects
  extractJsRedirects(content, result);

  return result;
}

/**
 * Extract the page heading/title set via {% set pageHeading = "..." %}
 */
function extractPageTitle(content) {
  const match = content.match(
    /\{%\s*set\s+pageHeading\s*=\s*["']([^"']+)["']\s*%\}/,
  );
  return match ? match[1] : null;
}

/**
 * Extract a {% set variable = "value" %} declaration
 */
function extractVariable(content, name) {
  const regex = new RegExp(
    `\\{%\\s*set\\s+${name}\\s*=\\s*["']([^"']+)["']\\s*%\\}`,
  );
  const match = content.match(regex);
  return match ? match[1] : null;
}

/**
 * Extract {% extends '...' %}
 */
function extractExtends(content) {
  const match = content.match(/\{%\s*extends\s+['"]([^'"]+)['"]\s*%\}/);
  return match ? match[1] : null;
}

/**
 * Extract back link URL
 */
function extractBackLink(content) {
  const match = content.match(
    /\{%\s*set\s+backLinkURL\s*=\s*["']([^"']+)["']\s*%\}/,
  );
  return match ? match[1] : null;
}

/**
 * Extract links (href) and form actions, tracking whether they're
 * inside {% if %} conditional blocks
 */
function extractLinksAndForms(content, result) {
  // Split content into lines for context tracking
  const lines = content.split("\n");

  // Track conditional nesting
  const conditionStack = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track {% if %} blocks
    const ifMatch = line.match(/\{%[-\s]*if\s+(.+?)\s*[-]?%\}/);
    if (ifMatch) {
      conditionStack.push({
        condition: ifMatch[1].trim(),
        line: i + 1,
      });
    }

    // Track {% elif %} / {% elseif %}
    const elifMatch = line.match(/\{%[-\s]*(?:elif|elseif)\s+(.+?)\s*[-]?%\}/);
    if (elifMatch && conditionStack.length > 0) {
      conditionStack[conditionStack.length - 1] = {
        condition: elifMatch[1].trim(),
        line: i + 1,
      };
    }

    // Track {% else %}
    if (/\{%[-\s]*else\s*[-]?%\}/.test(line) && conditionStack.length > 0) {
      const prev = conditionStack[conditionStack.length - 1];
      conditionStack[conditionStack.length - 1] = {
        condition: `NOT (${prev.condition})`,
        line: i + 1,
        isElse: true,
      };
    }

    // Track {% endif %}
    if (/\{%[-\s]*endif\s*[-]?%\}/.test(line)) {
      conditionStack.pop();
    }

    // Extract href attributes — three patterns:
    // 1. HTML attribute:          href="/path"
    // 2. Quoted object key:       "href": "/path"  (some macros)
    // 3. Unquoted object key:     href: "/path"    (nhsappCardGroup, govuk macros)
    const hrefRegex = /(?:href=["']|["']href["']\s*:\s*["']|href\s*:\s*["'])([^"']+)["']/g;
    let hrefMatch;
    while ((hrefMatch = hrefRegex.exec(line)) !== null) {
      const href = hrefMatch[1];
      if (isInternalLink(href)) {
        const linkData = {
          target: normalisePath(href),
          type: "link",
          line: i + 1,
          label: extractLinkText(lines, i),
        };

        if (conditionStack.length > 0) {
          linkData.condition =
            conditionStack[conditionStack.length - 1].condition;
          result.conditionalLinks.push(linkData);
        } else {
          result.links.push(linkData);
        }
      }
    }

    // Extract form action attributes
    const actionRegex = /action=["']([^"']+)["']/g;
    let actionMatch;
    while ((actionMatch = actionRegex.exec(line)) !== null) {
      const action = actionMatch[1];
      if (isInternalLink(action)) {
        const formData = {
          target: normalisePath(action),
          type: "form",
          method: extractFormMethod(line),
          line: i + 1,
          label: extractButtonText(lines, i),
        };

        if (conditionStack.length > 0) {
          formData.condition =
            conditionStack[conditionStack.length - 1].condition;
          result.conditionalLinks.push(formData);
        } else {
          result.formActions.push(formData);
        }
      }
    }
  }
}

/**
 * Extract JS-based redirects like location.href = "/..."
 */
function extractJsRedirects(content, result) {
  const regex = /location\.href\s*=\s*["']([^"']+)["']/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (isInternalLink(match[1])) {
      result.jsRedirects.push({
        target: normalisePath(match[1]),
        type: "js-redirect",
        label: "Auto-redirect",
      });
    }
  }
}

/**
 * Check if a link is internal (not external, anchor, or javascript)
 */
function isInternalLink(href) {
  if (!href) return false;
  if (href.startsWith("#")) return false;
  if (href.startsWith("javascript:")) return false;
  if (href.startsWith("http://") || href.startsWith("https://")) return false;
  if (href.startsWith("mailto:") || href.startsWith("tel:")) return false;
  if (href === "/") return true;
  return href.startsWith("/");
}

/**
 * Normalise a URL path (remove query strings, trailing slashes)
 */
function normalisePath(urlPath) {
  let normalised = urlPath.split("?")[0].split("#")[0];
  if (normalised !== "/" && normalised.endsWith("/")) {
    normalised = normalised.slice(0, -1);
  }
  return normalised;
}

/**
 * Try to extract link text from nearby lines
 */
function extractLinkText(lines, lineIndex) {
  const line = lines[lineIndex];
  // Try to get text content between > and </a>
  const textMatch = line.match(/>([^<]+)<\/a>/);
  if (textMatch) return textMatch[1].trim();

  // Look backward up to 3 lines for a title: "..." property (Nunjucks macro params)
  for (let back = 1; back <= 3; back++) {
    if (lineIndex - back < 0) break;
    const prevLine = lines[lineIndex - back].trim();
    const titleMatch = prevLine.match(/title\s*:\s*["']([^"']+)["']/);
    if (titleMatch) return titleMatch[1];
    // Stop scanning back if we hit an unrelated block
    if (prevLine.startsWith("{%") || prevLine === "{") break;
  }

  // Check next line for text content
  if (lineIndex + 1 < lines.length) {
    const nextLine = lines[lineIndex + 1].trim();
    if (
      nextLine &&
      !nextLine.startsWith("<") &&
      !nextLine.startsWith("{") &&
      nextLine !== "}," &&
      nextLine !== "}"
    ) {
      return nextLine.replace(/<[^>]+>/g, "").trim();
    }
  }

  return null;
}

/**
 * Extract form method from line
 */
function extractFormMethod(line) {
  const match = line.match(/method=["'](\w+)["']/i);
  return match ? match[1].toUpperCase() : "GET";
}

/**
 * Try to find the button text for a form
 */
function extractButtonText(lines, startIndex) {
  // Look ahead for a button element
  for (let i = startIndex; i < Math.min(startIndex + 30, lines.length); i++) {
    const btnMatch = lines[i].match(/text:\s*["']([^"']+)["']/);
    if (btnMatch) return btnMatch[1];
    const htmlBtnMatch = lines[i].match(/<button[^>]*>([^<]+)<\/button>/);
    if (htmlBtnMatch) return htmlBtnMatch[1].trim();
  }
  return "Submit";
}

module.exports = { parseTemplate };
