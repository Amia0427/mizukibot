#!/usr/bin/env python3
import argparse
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


ARXIV_API_URL = "http://export.arxiv.org/api/query"
ATOM_NS = {"atom": "http://www.w3.org/2005/Atom"}
MAX_RESULTS_DEFAULT = 5
MAX_RESULTS_LIMIT = 10
ABSTRACT_EXCERPT_LIMIT = 320


def clamp_max_results(value):
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = MAX_RESULTS_DEFAULT
    return max(1, min(MAX_RESULTS_LIMIT, n))


def split_csv(value):
    if not value:
        return []
    return [item.strip() for item in str(value).split(",") if item and item.strip()]


def sanitize_text(value):
    return " ".join(str(value or "").split()).strip()


def sanitize_url(url):
    text = str(url or "").strip()
    if not text:
        return ""
    if text.startswith("http://"):
        text = "https://" + text[len("http://"):]
    return text


def extract_arxiv_id(id_url):
    text = str(id_url or "").strip()
    if "/abs/" in text:
        return text.split("/abs/", 1)[1]
    return text


def build_pdf_url(arxiv_id):
    if not arxiv_id:
        return ""
    return f"https://arxiv.org/pdf/{arxiv_id}.pdf"


def build_abs_url(arxiv_id):
    if not arxiv_id:
        return ""
    return f"https://arxiv.org/abs/{arxiv_id}"


def build_search_query(query="", categories=None, tags=None):
    parts = []

    clean_query = sanitize_text(query)
    if clean_query:
        parts.append(f"all:{clean_query}")

    categories = categories or []
    if categories:
        cat_parts = [f"cat:{item}" for item in categories if sanitize_text(item)]
        if len(cat_parts) == 1:
            parts.append(cat_parts[0])
        elif cat_parts:
            parts.append("(" + "+OR+".join(cat_parts) + ")")

    tags = tags or []
    if tags:
        tag_parts = [f"all:{sanitize_text(item)}" for item in tags if sanitize_text(item)]
        if len(tag_parts) == 1:
            parts.append(tag_parts[0])
        elif tag_parts:
            parts.append("(" + "+OR+".join(tag_parts) + ")")

    return "+AND+".join(parts) if parts else "all:*"


def request_arxiv(params, timeout=30):
    query = urllib.parse.urlencode(params)
    url = f"{ARXIV_API_URL}?{query}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "MizukiBot/1.0 (arxiv skill)"
        }
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()


def parse_entries(xml_bytes):
    root = ET.fromstring(xml_bytes)
    entries = []
    for entry in root.findall("atom:entry", ATOM_NS):
        id_url = sanitize_text(entry.findtext("atom:id", default="", namespaces=ATOM_NS))
        arxiv_id = extract_arxiv_id(id_url)
        title = sanitize_text(entry.findtext("atom:title", default="", namespaces=ATOM_NS))
        abstract = sanitize_text(entry.findtext("atom:summary", default="", namespaces=ATOM_NS))
        published = sanitize_text(entry.findtext("atom:published", default="", namespaces=ATOM_NS))
        updated = sanitize_text(entry.findtext("atom:updated", default="", namespaces=ATOM_NS))
        authors = [
            sanitize_text(author.findtext("atom:name", default="", namespaces=ATOM_NS))
            for author in entry.findall("atom:author", ATOM_NS)
        ]
        categories = []
        for category in entry.findall("atom:category", ATOM_NS):
            term = sanitize_text(category.attrib.get("term", ""))
            if term:
                categories.append(term)
        pdf_url = ""
        for link in entry.findall("atom:link", ATOM_NS):
            if sanitize_text(link.attrib.get("type", "")) == "application/pdf":
                pdf_url = sanitize_url(link.attrib.get("href", ""))
                break
        if not pdf_url:
            pdf_url = build_pdf_url(arxiv_id)
        abs_url = sanitize_url(id_url) or build_abs_url(arxiv_id)
        entries.append({
            "arxiv_id": arxiv_id,
            "title": title,
            "abstract": abstract,
            "authors": [item for item in authors if item],
            "categories": categories,
            "published": published,
            "updated": updated,
            "pdf_url": pdf_url,
            "abs_url": abs_url
        })
    return entries


def format_date(text):
    value = sanitize_text(text)
    if len(value) >= 10:
        return value[:10]
    return value


def format_author_list(authors):
    items = [sanitize_text(item) for item in (authors or []) if sanitize_text(item)]
    return ", ".join(items) if items else "Unknown"


def excerpt(text, limit=ABSTRACT_EXCERPT_LIMIT):
    normalized = sanitize_text(text)
    if len(normalized) <= limit:
        return normalized
    return normalized[: max(0, limit - 3)].rstrip() + "..."


def format_search_results(entries):
    if not entries:
        return "未找到匹配论文。"

    blocks = []
    for index, item in enumerate(entries, 1):
        blocks.append("\n".join([
            f"{index}. [{item['arxiv_id']}] {item['title']}",
            f"作者: {format_author_list(item['authors'])}",
            f"发布日期: {format_date(item['published'])}",
            f"分类: {', '.join(item['categories']) if item['categories'] else 'Unknown'}",
            f"摘要: {excerpt(item['abstract']) or '无摘要'}",
            f"abs: {item['abs_url'] or build_abs_url(item['arxiv_id'])}",
            f"pdf: {item['pdf_url'] or build_pdf_url(item['arxiv_id'])}"
        ]))
    return "\n\n".join(blocks)


def format_single_result(item, include_abstract=True):
    if not item:
        return "未找到匹配论文。"

    lines = [
        f"arXiv ID: {item['arxiv_id']}",
        f"标题: {item['title'] or 'Unknown'}",
        f"作者: {format_author_list(item['authors'])}",
        f"发布日期: {format_date(item['published'])}",
        f"更新日期: {format_date(item['updated'])}",
        f"分类: {', '.join(item['categories']) if item['categories'] else 'Unknown'}"
    ]
    if include_abstract:
        lines.append(f"摘要: {sanitize_text(item['abstract']) or '无摘要'}")
    lines.append(f"abs: {item['abs_url'] or build_abs_url(item['arxiv_id'])}")
    lines.append(f"pdf: {item['pdf_url'] or build_pdf_url(item['arxiv_id'])}")
    return "\n".join(lines)


def run_search(args):
    params = {
        "search_query": build_search_query(query=args.query, categories=args.categories, tags=args.tags),
        "start": 0,
        "max_results": clamp_max_results(args.max_results),
        "sortBy": "relevance",
        "sortOrder": "descending"
    }
    data = request_arxiv(params, timeout=args.timeout)
    return format_search_results(parse_entries(data))


def run_get(args):
    params = {
        "id_list": sanitize_text(args.arxiv_id),
        "max_results": 1
    }
    data = request_arxiv(params, timeout=args.timeout)
    entries = parse_entries(data)
    if not entries:
        return "未找到匹配论文。"
    return format_single_result(entries[0], include_abstract=bool(args.include_abstract))


def run_latest(args):
    params = {
        "search_query": build_search_query(categories=args.categories, tags=args.tags),
        "start": 0,
        "max_results": clamp_max_results(args.max_results),
        "sortBy": "submittedDate",
        "sortOrder": "descending"
    }
    data = request_arxiv(params, timeout=args.timeout)
    return format_search_results(parse_entries(data))


def build_parser():
    parser = argparse.ArgumentParser(description="Local arXiv skill tool")
    parser.add_argument("--timeout", type=int, default=30)
    subparsers = parser.add_subparsers(dest="command", required=True)

    search_parser = subparsers.add_parser("search")
    search_parser.add_argument("--query", required=True)
    search_parser.add_argument("--max-results", default=MAX_RESULTS_DEFAULT)
    search_parser.add_argument("--categories", default="")
    search_parser.add_argument("--tags", default="")

    get_parser = subparsers.add_parser("get")
    get_parser.add_argument("--id", dest="arxiv_id", required=True)
    get_parser.add_argument("--include-abstract", default="true")

    latest_parser = subparsers.add_parser("latest")
    latest_parser.add_argument("--max-results", default=MAX_RESULTS_DEFAULT)
    latest_parser.add_argument("--categories", default="")
    latest_parser.add_argument("--tags", default="")

    return parser


def normalize_args(args):
    args.categories = split_csv(getattr(args, "categories", ""))
    args.tags = split_csv(getattr(args, "tags", ""))
    args.max_results = clamp_max_results(getattr(args, "max_results", MAX_RESULTS_DEFAULT))
    include_abstract = str(getattr(args, "include_abstract", "true")).strip().lower()
    args.include_abstract = include_abstract not in ("0", "false", "no", "off")
    args.query = sanitize_text(getattr(args, "query", ""))
    args.arxiv_id = sanitize_text(getattr(args, "arxiv_id", ""))
    try:
        args.timeout = max(5, min(60, int(getattr(args, "timeout", 30))))
    except (TypeError, ValueError):
        args.timeout = 30
    return args


def main():
    parser = build_parser()
    args = normalize_args(parser.parse_args())
    try:
        if args.command == "search":
            print(run_search(args))
            return 0
        if args.command == "get":
            print(run_get(args))
            return 0
        if args.command == "latest":
            print(run_latest(args))
            return 0
        print("Unsupported command.")
        return 1
    except urllib.error.HTTPError as error:
        print(f"arXiv 请求失败: HTTP {error.code}")
        return 1
    except urllib.error.URLError as error:
        reason = getattr(error, "reason", "") or str(error)
        print(f"arXiv 请求失败: {reason}")
        return 1
    except ET.ParseError:
        print("arXiv 返回内容解析失败。")
        return 1
    except Exception as error:
        print(f"arXiv 工具执行失败: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
