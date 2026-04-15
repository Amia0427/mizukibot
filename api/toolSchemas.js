// api/toolSchemas.js
// Split from toolRegistry.js for maintainability.
const TOOL_SCHEMAS = [
  // ===== tools.js =====
  {
    type: 'function',
    function: {
      name: 'getLyrics',
      description: '鏌ヨ姝屾洸姝岃瘝',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getWeather',
      description: '鏌ヨ鍩庡競澶╂皵',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '鍩庡競鍚嶆垨澶╂皵璇锋眰鏂囨湰' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_nearby_places',
      description: 'Search nearby places in a city',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'string' },
          city: { type: 'string' }
        },
        required: ['keywords']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_academic_paper',
      description: 'Search academic papers',
      parameters: {
        type: 'object',
        properties: { keywords: { type: 'string' } },
        required: ['keywords']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_arcaea_info',
      description: '鏌ヨ Arcaea 鏇茬洰淇℃伅',
      parameters: {
        type: 'object',
        properties: { song_name: { type: 'string' } },
        required: ['song_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_bilibili_hot',
      description: 'Get Bilibili trending topics',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '缃戦〉鎼滅储',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch and extract readable webpage content from a URL',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Webpage URL to fetch and extract' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'currency_convert',
      description: '姹囩巼鎹㈢畻',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          amount: { type: 'number' }
        },
        required: ['from', 'to']
      }
    }
  },

  // ===== tools_batch2.js =====
  {
    type: 'function',
    function: {
      name: 'url_safety_check',
      description: '妫€鏌?URL 椋庨櫓',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'json_validate',
      description: 'Validate JSON and provide fix suggestions',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'study_card_generator',
      description: '鐢熸垚瀛︿範鍗＄墖',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          points: { type: 'string' },
          count: { type: 'number' }
        },
        required: ['topic']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'meeting_minutes_struct',
      description: 'Structure meeting notes',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      }
    }
  },

  // ===== tools_batch3.js =====
  {
    type: 'function',
    function: {
      name: 'extract_todo_from_text',
      description: 'Extract TODO items from text',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pomodoro_plan',
      description: 'Generate a pomodoro plan',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string' },
          total_minutes: { type: 'number' },
          focus_minutes: { type: 'number' },
          break_minutes: { type: 'number' }
        },
        required: ['goal']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'regex_tester',
      description: 'Test regular expressions',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          text: { type: 'string' },
          flags: { type: 'string' }
        },
        required: ['pattern', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'text_stats',
      description: 'Text statistics',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          top_n: { type: 'number' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'safe_eval_math',
      description: 'Safely evaluate math expressions',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression']
      }
    }
  },

  // ===== tools_batch4.js =====
  {
    type: 'function',
    function: {
      name: 'notebook_reindex_folder',
      description: 'Reindex local notebook knowledge base',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          folderPath: { type: 'string' },
          options: { type: 'object' }
        },
        required: ['userId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notebook_add_document',
      description: '鍚戞湰鍦扮煡璇嗗簱鏂板鏂囨。',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['userId', 'title', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notebook_list_docs',
      description: 'List notebook documents',
      parameters: {
        type: 'object',
        properties: { userId: { type: 'string' } },
        required: ['userId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notebook_search',
      description: '搜索知识库片段',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          query: { type: 'string' },
          top_k: { type: 'number' }
        },
        required: ['userId', 'query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_cli',
      description: 'Read-only virtual CLI for long-term memory lookup. The command field must contain only a bare command string, not JSON, not code fences, and not explanatory text. Valid chat examples: `mem search --query "likes"`; `mem open --ref "mc_ref:..."`; `mem open --source profile`; `mem open --source personal --id "..."`. In normal chat do not use `mem ls` or `mem stats`.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'A single bare memory_cli command string only. Do not include `command:` prefixes, JSON wrappers, markdown code fences, or natural-language explanation. Prefer `mem search --query "..."` first, then `mem open --ref "..."` if needed.'
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_context_stats',
      description: 'Inspect the effective context prepared for the main conversation model in the current turn. Use this when the user asks about current context usage, remaining context, token usage, or whether the chat is close to the context limit.',
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            description: 'Optional output format. Leave empty or use "text".'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'self_improvement_recent',
      description: 'Read recent self-improvement events. Admin-only read surface.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          kind: { type: 'string' },
          status: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'self_improvement_search',
      description: 'Search self-improvement events. Admin-only read surface.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          top_k: { type: 'number' },
          kind: { type: 'string' },
          promoted_only: { type: 'boolean' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'self_improvement_patterns',
      description: 'Read aggregated self-improvement patterns. Admin-only read surface.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          route_policy_key: { type: 'string' },
          tool_name: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'self_improvement_rules',
      description: 'Read promoted self-improvement runtime rules. Admin-only read surface.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          pattern_key: { type: 'string' },
          top_route_type: { type: 'string' },
          tool_name: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'self_improvement_guides',
      description: 'Read promoted self-improvement local guides. Admin-only read surface.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          pattern_key: { type: 'string' },
          active_only: { type: 'boolean' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notebook_append_journal',
      description: '杩藉姞鏃ヨ',
      parameters: {
        type: 'object',
        properties: {
          entry: { type: 'string' },
          tag: { type: 'string' }
        },
        required: ['entry']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notebook_read_recent_journal',
      description: 'Read recent journal entries',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' }
        }
      }
    }
  },

  // ===== tools_extra.js =====
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '鑾峰彇褰撳墠鏃堕棿',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'translate_text',
      description: '缈昏瘧鏂囨湰',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          to: { type: 'string' },
          from: { type: 'string' }
        },
        required: ['text', 'to']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_rss_feed',
      description: '璇诲彇 RSS/Atom',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_uuid',
      description: '鐢熸垚 UUID',
      parameters: {
        type: 'object',
        properties: {
          version: { type: 'string', description: '鐩墠鏀寔 v4' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'hash_text',
      description: '璁＄畻鏂囨湰鍝堝笇',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          algorithm: { type: 'string', description: 'md5|sha1|sha256|sha512' },
          encoding: { type: 'string', description: 'hex|base64' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'extract_urls',
      description: '浠庢枃鏈彁鍙?URL',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          unique: { type: 'boolean' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'json_query',
      description: 'Query value by JSON path',
      parameters: {
        type: 'object',
        properties: {
          json_text: { type: 'string' },
          path: { type: 'string', description: '濡?a.b[0].c' }
        },
        required: ['json_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'render_template',
      description: 'Render string template',
      parameters: {
        type: 'object',
        properties: {
          template: { type: 'string', description: 'Supports placeholders like {{name}}' },
          variables: { type: 'object' }
        },
        required: ['template']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'jwt_decode',
      description: 'Decode JWT without signature verification',
      parameters: {
        type: 'object',
        properties: {
          token: { type: 'string' }
        },
        required: ['token']
      }
    }
  },

  // ===== skills_assistant.js =====
  {
    type: 'function',
    function: {
      name: 'assistant_task_breakdown',
      description: 'Break down a goal into actionable tasks',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string' },
          constraints: { type: 'string' },
          max_tasks: { type: 'number' }
        },
        required: ['goal']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'assistant_weekly_agenda',
      description: 'Generate a weekly agenda',
      parameters: {
        type: 'object',
        properties: {
          goals: { type: 'array', items: { type: 'string' } },
          start_date: { type: 'string' },
          focus_hours_per_day: { type: 'number' }
        },
        required: ['goals']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'assistant_meeting_agenda',
      description: 'Generate a structured meeting agenda',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          participants: { type: 'array', items: { type: 'string' } },
          duration_minutes: { type: 'number' },
          goals: { type: 'array', items: { type: 'string' } }
        },
        required: ['topic']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'assistant_email_draft',
      description: 'Draft an email based on intent',
      parameters: {
        type: 'object',
        properties: {
          intent: { type: 'string' },
          recipient: { type: 'string' },
          key_points: { type: 'array', items: { type: 'string' } },
          tone: { type: 'string' }
        },
        required: ['intent']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'assistant_decision_matrix',
      description: 'Build a weighted decision matrix and ranking',
      parameters: {
        type: 'object',
        properties: {
          options: { type: 'array', items: { type: 'string' } },
          criteria: { type: 'array', items: { type: 'string' } },
          weights: { type: 'object' }
        },
        required: ['options', 'criteria']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'assistant_daily_brief',
      description: 'Generate a daily brief template',
      parameters: {
        type: 'object',
        properties: {
          yesterday: { type: 'array', items: { type: 'string' } },
          today: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } },
          mood: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'research_question_refiner',
      description: '细化研究主题并生成可执行研究问题',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          domain: { type: 'string' },
          constraints: { type: 'string' },
          expected_output: { type: 'string' }
        },
        required: ['topic']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'research_literature_matrix',
      description: 'Generate literature comparison matrix',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          papers: { type: 'array', items: { type: 'string' } },
          dimensions: { type: 'array', items: { type: 'string' } }
        },
        required: ['topic']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'research_experiment_plan',
      description: 'Generate research experiment plan',
      parameters: {
        type: 'object',
        properties: {
          hypothesis: { type: 'string' },
          variables: { type: 'array', items: { type: 'string' } },
          datasets: { type: 'array', items: { type: 'string' } },
          timeline_days: { type: 'number' }
        },
        required: ['hypothesis']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'research_paper_outline',
      description: 'Generate research paper/report outline',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          contribution_points: { type: 'array', items: { type: 'string' } },
          target_venue: { type: 'string' },
          language: { type: 'string' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'research_peer_review_checklist',
      description: 'Generate pre-submission review checklist',
      parameters: {
        type: 'object',
        properties: {
          manuscript_type: { type: 'string' },
          strictness: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'study_syllabus_plan',
      description: 'Generate syllabus and weekly learning roadmap',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          level: { type: 'string' },
          weeks: { type: 'number' },
          weekly_hours: { type: 'number' }
        },
        required: ['subject']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'study_active_recall_quiz',
      description: 'Generate active recall quiz',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          points: { type: 'array', items: { type: 'string' } },
          count: { type: 'number' },
          difficulty: { type: 'string' }
        },
        required: ['topic']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'study_exam_revision_plan',
      description: 'Generate exam revision sprint plan',
      parameters: {
        type: 'object',
        properties: {
          exam_name: { type: 'string' },
          days_left: { type: 'number' },
          subjects: { type: 'array', items: { type: 'string' } },
          daily_hours: { type: 'number' }
        },
        required: ['exam_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'research_abstract_structurer',
      description: 'Structure abstract into IMRaD-like fields',
      parameters: {
        type: 'object',
        properties: {
          raw_abstract: { type: 'string' },
          max_sentences: { type: 'number' }
        },
        required: ['raw_abstract']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'research_intro_paragraph_builder',
      description: 'Generate intro paragraph blocks from problem-gap-contribution',
      parameters: {
        type: 'object',
        properties: {
          problem: { type: 'string' },
          gap: { type: 'string' },
          contributions: { type: 'array', items: { type: 'string' } },
          tone: { type: 'string' }
        },
        required: ['problem']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'research_result_interpreter',
      description: 'Interpret experiment metrics and provide analysis checklist',
      parameters: {
        type: 'object',
        properties: {
          metrics: { type: 'array', items: { type: 'string' } },
          baselines: { type: 'array', items: { type: 'string' } },
          observations: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'study_mistake_diagnosis',
      description: 'Diagnose mistakes and produce targeted drill plan',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          mistakes: { type: 'array', items: { type: 'string' } },
          days: { type: 'number' }
        },
        required: ['subject']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'study_spaced_repetition_plan',
      description: 'Generate a spaced repetition review plan',
      parameters: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'string' }, description: 'Topics or memory items to review' },
          days: { type: 'number', description: 'Planning horizon in days' },
          intensity: { type: 'string', description: 'light|normal|intense' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_qqbot_dep_check',
      description: 'Check whether the qqbot skill Python dependencies are ready',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_web_search',
      description: 'Search the web with the local free search wrapper',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          keyword: { type: 'string', description: 'Alias of query' },
          q: { type: 'string', description: 'Alias of query' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_arxiv_search',
      description: 'Search arXiv papers by keyword with optional category and tag filters',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Maximum results, 1-10' },
          categories: { type: 'array', items: { type: 'string' }, description: 'Optional arXiv category codes' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional keyword filters' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_arxiv_get',
      description: 'Fetch a paper from arXiv by arXiv ID',
      parameters: {
        type: 'object',
        properties: {
          arxiv_id: { type: 'string', description: 'arXiv ID such as 2501.12345' },
          include_abstract: { type: 'boolean', description: 'Whether to include the full abstract' }
        },
        required: ['arxiv_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_arxiv_latest',
      description: 'List recent arXiv papers by categories and optional tags',
      parameters: {
        type: 'object',
        properties: {
          categories: { type: 'array', items: { type: 'string' }, description: 'Optional arXiv category codes' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional keyword filters' },
          max_results: { type: 'number', description: 'Maximum results, 1-10' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_weather',
      description: 'Query current weather for a location with wttr.in',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'Location name' },
          city: { type: 'string', description: 'Alias of location' },
          text: { type: 'string', description: 'Alias of location' },
          format: { type: 'string', description: 'wttr.in format string' }
        },
        required: ['location']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_youtube_transcript',
      description: 'Fetch transcript text for a YouTube video',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'YouTube video URL' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_summarize',
      description: 'Summarize a URL or local file with the summarize CLI',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'URL or local file path' },
          url: { type: 'string', description: 'Alias of input' },
          file: { type: 'string', description: 'Alias of input' },
          model: { type: 'string', description: 'Optional summarize model override' },
          length: { type: 'string', description: 'short|medium|long' },
          json: { type: 'boolean', description: 'Return JSON output when supported' }
        },
        required: ['input']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_vetter_report',
      description: 'Run a local static safety review for a skill package',
      parameters: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: 'Skill folder name under skills/' },
          name: { type: 'string', description: 'Alias of skill_name' }
        },
        required: ['skill_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_brave_search',
      description: 'Free web search (no API key required)',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Maximum results, 1-20' },
          include_content: { type: 'boolean', description: 'Whether to include extracted page content' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_brave_extract',
      description: 'Extract webpage text from URL (free, no API key required)',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Webpage URL to extract' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_tavily_search',
      description: 'Free web search alias (no API key required)',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Maximum results, 1-20' },
          topic: { type: 'string', description: 'general|news' },
          deep: { type: 'boolean', description: 'Whether to enable deeper research' },
          days: { type: 'number', description: 'Recency window in days' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_tavily_extract',
      description: 'Extract webpage text alias (free, no API key required)',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Webpage URL to extract' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_stock_analyze',
      description: 'Analyze one or more stock or crypto tickers',
      parameters: {
        type: 'object',
        properties: {
          tickers: { type: 'array', items: { type: 'string' }, description: 'Ticker list' },
          ticker: { type: 'string', description: 'Single ticker, as an alternative to tickers' },
          output: { type: 'string', description: 'text|json|markdown' },
          fast: { type: 'boolean', description: 'Use the faster analysis mode' },
          no_insider: { type: 'boolean', description: 'Skip insider-trading data' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_stock_dividend',
      description: 'Query dividend information for one or more tickers',
      parameters: {
        type: 'object',
        properties: {
          tickers: { type: 'array', items: { type: 'string' }, description: 'Ticker list' },
          ticker: { type: 'string', description: 'Single ticker, as an alternative to tickers' },
          output: { type: 'string', description: 'text|json|markdown' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_stock_price_query',
      description: 'Query real-time stock and index prices for A-shares, HK, and US markets',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Single stock or index code' },
          codes: { type: 'array', items: { type: 'string' }, description: 'Multiple stock or index codes' },
          ticker: { type: 'string', description: 'Alias of code' },
          tickers: { type: 'array', items: { type: 'string' }, description: 'Alias of codes' },
          market: { type: 'string', description: 'Optional market: sh|sz|hk|us' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_ontology_graph',
      description: 'Operate an isolated local ontology graph stored under DATA_DIR/skill_cache/ontology',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'create|get|query|list|update|delete|relate|related|validate|schema-append' },
          id: { type: 'string' },
          type: { type: 'string' },
          props: { type: 'object' },
          where: { type: 'object' },
          from_id: { type: 'string' },
          from: { type: 'string' },
          rel: { type: 'string' },
          to_id: { type: 'string' },
          to: { type: 'string' },
          dir: { type: 'string', description: 'outgoing|incoming|both' },
          data: { type: 'object', description: 'Schema fragment for schema-append' },
          schema: { type: 'object', description: 'Alias of data' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_stock_watchlist',
      description: 'Manage the stock watchlist and alert conditions',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'add|remove|list|check' },
          ticker: { type: 'string', description: 'Ticker symbol' },
          target: { type: 'number', description: 'Target price' },
          stop: { type: 'number', description: 'Stop-loss price' },
          alert_on_signal: { type: 'boolean', description: 'Alert when a signal is detected' },
          notify: { type: 'boolean', description: 'Enable notifications' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_skill_validate',
      description: 'Validate a local skill package',
      parameters: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: 'Skill folder name under skills/' }
        },
        required: ['skill_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_stock_hot',
      description: 'Scan for hot stock opportunities and market signals',
      parameters: {
        type: 'object',
        properties: {
          no_social: { type: 'boolean', description: 'Skip social-signal sources' },
          json: { type: 'boolean', description: 'Return JSON output' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_stock_portfolio',
      description: 'Manage local stock portfolios',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'create|list|show|delete|rename|add|update|remove' },
          name: { type: 'string', description: 'Portfolio name for create/delete' },
          old_name: { type: 'string', description: 'Current portfolio name for rename' },
          new_name: { type: 'string', description: 'New portfolio name for rename' },
          portfolio: { type: 'string', description: 'Portfolio name' },
          ticker: { type: 'string', description: 'Ticker symbol, including crypto tickers' },
          quantity: { type: 'number', description: 'Position quantity for add/update' },
          cost: { type: 'number', description: 'Average cost for add/update' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_stock_rumor',
      description: 'Scan recent market rumors',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_ppt_generate',
      description: 'Generate a PPT with the AI PPT skill. Requires BAIDU_API_KEY',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'PPT topic or requirement' },
          style_id: { type: 'number', description: 'Optional style_id' },
          tpl_id: { type: 'number', description: 'Optional tpl_id' },
          web_content: { type: 'string', description: 'Optional supplementary web content' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_ppt_theme_list',
      description: 'List AI PPT themes. Requires BAIDU_API_KEY',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_agent_browser_guide',
      description: 'Read the local agent-browser skill guide and relevant references',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional topic or question to focus the guide output' },
          reference: { type: 'string', description: 'Optional reference filename hint' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_api_gateway_reference',
      description: 'Read the local API gateway skill guide and reference docs',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          reference: { type: 'string', description: 'Reference folder or file hint' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_auto_updater_guide',
      description: 'Read the local auto-updater skill guide',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_byterover_guide',
      description: 'Read the local byterover skill guide',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_clawddocs_reference',
      description: 'Read the local clawddocs skill guide and doc references',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          reference: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_clawddocs_search',
      description: 'Search local clawddocs indexes/scripts for documentation topics',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword to search in clawddocs' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_clawddocs_fetch',
      description: 'Fetch a specific clawddocs document by path',
      parameters: {
        type: 'object',
        properties: {
          doc_path: { type: 'string', description: 'Document path such as gateway/configuration' }
        },
        required: ['doc_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_find_skills_guide',
      description: 'Read the local find-skills workflow guide',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_free_ride_guide',
      description: 'Read the local free-ride skill guide',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_github_api_guide',
      description: 'Read the local github-api skill guide',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_gog_guide',
      description: 'Read the local gog skill guide',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_humanizer_guide',
      description: 'Read the local humanizer skill guide',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_larry_guide',
      description: 'Read the local larry skill guide and references',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          reference: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_n8n_workflow_guide',
      description: 'Read the local n8n workflow automation skill guide',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_nano_pdf_guide',
      description: 'Read the local nano-pdf skill guide',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_obsidian_guide',
      description: 'Read the local obsidian skill guide',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_openai_whisper_guide',
      description: 'Read the local openai-whisper skill guide',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_proactive_agent_guide',
      description: 'Read the local proactive-agent skill guide and assets',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          reference: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_research_cog_guide',
      description: 'Read the local research-cog skill guide',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_self_improving_agent_guide',
      description: 'Read the local self-improving-agent skill guide and references',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          reference: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_skillhub_preference_guide',
      description: 'Read the local skillhub-preference skill guide',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_youtube_api_guide',
      description: 'Read the local youtube-api-skill guide',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_image_generate_pro',
      description: 'Generate or edit images with Nano Banana Pro. Requires GEMINI_API_KEY',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Image prompt' },
          filename: { type: 'string', description: 'Output filename or absolute output path' },
          input_image: { type: 'string', description: 'Optional input image path for editing' },
          resolution: { type: 'string', description: '1K|2K|4K' },
          api_key: { type: 'string', description: 'Optional override for GEMINI_API_KEY' }
        },
        required: ['prompt']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'minecraft_connect',
      description: 'Connect agent to a Minecraft server',
      parameters: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Minecraft server host' },
          port: { type: 'number', description: 'Minecraft server port' },
          username: { type: 'string', description: 'Bot username' },
          auth: { type: 'string', description: 'offline|mojang|microsoft' },
          version: { type: 'string', description: 'Protocol/game version, optional' },
          password: { type: 'string', description: 'Password when auth mode requires it' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'minecraft_disconnect',
      description: 'Disconnect agent from Minecraft server',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Optional disconnect reason' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'minecraft_status',
      description: 'Get current Minecraft bot status',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'minecraft_chat',
      description: 'Send chat message in Minecraft',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Chat text to send' }
        },
        required: ['message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'minecraft_move_to',
      description: 'Move to target coordinates using pathfinder',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          range: { type: 'number', description: 'Acceptable radius around target' },
          timeout_ms: { type: 'number', description: 'Pathfinding timeout in milliseconds' }
        },
        required: ['x', 'y', 'z']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'minecraft_follow_player',
      description: 'Follow a player continuously',
      parameters: {
        type: 'object',
        properties: {
          player: { type: 'string', description: 'Target player name' },
          distance: { type: 'number', description: 'Keep distance to target player' }
        },
        required: ['player']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'minecraft_look_at',
      description: 'Rotate the bot to look at a coordinate',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          force: { type: 'boolean', description: 'Force immediate view change' }
        },
        required: ['x', 'y', 'z']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'minecraft_stop',
      description: 'Stop current movement/follow action',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'publish_qzone',
      description: 'Publish a QZone post in the current admin-controlled group context',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'QZone post content for manual mode' },
          mode: { type: 'string', enum: ['manual', 'bot_diary'], description: 'manual or bot_diary' },
          hint: { type: 'string', description: 'Weak hint used only for bot_diary mode' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'schedule_group_message',
      description: 'Schedule a group message for the current group only',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Group message content' },
          when: { type: 'string', description: 'Time expression or 5-field cron' }
        },
        required: ['message', 'when']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_scheduled_command',
      description: 'Create a scheduled command for the current group only',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'group_message or qzone_post' },
          when: { type: 'string', description: 'Time expression or 5-field cron' },
          content: { type: 'string', description: 'Message content or manual QZone content' },
          mode: { type: 'string', enum: ['manual', 'bot_diary'], description: 'Only valid when action is qzone_post' },
          hint: { type: 'string', description: 'Weak hint used only for qzone_post bot_diary mode' }
        },
        required: ['action', 'when']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_scheduled_tasks',
      description: 'List scheduled tasks in the current group',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'mine or all' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_scheduled_task',
      description: 'Cancel a scheduled task in the current group',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Scheduled task ID' }
        },
        required: ['job_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_scheduled_task',
      description: 'Delete a scheduled task in the current group',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Scheduled task ID' }
        },
        required: ['job_id']
      }
    }
  }
];


module.exports = { TOOL_SCHEMAS };
