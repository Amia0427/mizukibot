const SAFETY_EXEMPT_PATTERN = /(防御|防止|检测|识别|排查|修复|清理|科普|解释|总结|翻译|新闻|报道|原理|为什么|风险|合法|合规|怎么办|恢复|止损|排障|defen[cs]e|prevent|detect|identify|investigate|triage|fix|cleanup|explain|summary|summari[sz]e|translate|news|report|principle|why|risk|legal|compliance|recovery|mitigation|remediation)/i;
const HARMFUL_MALICIOUS_ARTIFACT_PATTERN = /(钓鱼网站|钓鱼页|木马|病毒|勒索软件?|后门|僵尸网络|botnet|malware|ransomware|backdoor|trojan|炸弹|bomb)/i;
const HARMFUL_ARTIFACT_BUILD_PATTERN = /(教我|帮我|给我(?:一套|详细)?(?:步骤|教程|方法)|怎么(?:做|搞|写|建|搭|部署)|如何(?:做|搞|写|建|搭|部署)|写(?:一个|个)?|做(?:一个|个)?|制作|创建|生成|搭建|部署|build|make|create|generate|deploy|write|show me how|walk me through|give me steps)/i;
const HARMFUL_STEAL_OR_BYPASS_PATTERN = /(?:教我|帮我|给我(?:一套|详细)?(?:步骤|教程|方法)|怎么|如何|伪造|伪装|绕过|爆破|入侵|攻击|盗取|窃取|偷|破解|hack|steal|phish|exploit|bypass|attack|show me how|walk me through|give me steps)/i;
const HARMFUL_ACCOUNT_TARGET_PATTERNS = Object.freeze([
  /(?:偷|盗|窃取).{0,8}(?:密码|账号|cookie|凭证|验证码|session|token|credentials?)/i,
  /(?:密码|账号|cookie|凭证|验证码|session|token|credentials?).{0,8}(?:偷|盗|窃取)/i,
  /(?:破解|爆破|绕过).{0,8}(?:密码|账号|wifi|登录|验证码|二步验证|双重验证|2fa|mfa)/i,
  /(?:密码|账号|wifi|登录|验证码|二步验证|双重验证|2fa|mfa).{0,8}(?:破解|爆破|绕过)/i,
  /(?:phish|steal|exploit|bypass|hack|attack).{0,12}(?:password|account|cookie|token|session|credentials?|wifi|login|2fa|mfa)/i,
  /(?:password|account|cookie|token|session|credentials?|wifi|login|2fa|mfa).{0,12}(?:phish|steal|exploit|bypass|hack|attack)/i
]);
const BAD_FAITH_PATTERNS = Object.freeze([
  /(把这句话|同一句|同一段|这段话).{0,12}(重复|刷|连发).{0,12}(100|1000|10000|无限|不停|一直)/i,
  /(重复|刷屏|连发|轰炸).{0,12}(100|1000|10000|无限|不停|一直).{0,12}(群|聊天|对话|the chat|群里)/i,
  /(帮我|替我|去).{0,12}(群里|聊天里|对话里|the chat).{0,8}(刷屏|连发|轰炸)/i,
  /(帮我|替我).{0,10}(刷屏|轰炸|骚扰).{0,12}(他们|对方|别人|某人|那个人|someone|him|her|them)/i,
  /(spam|flood).{0,16}(the chat|someone|him|her|them)/i,
  /(harass|spam|flood).{0,12}(someone|the chat|them)/i,
  /(?:我要|我想|我要把|我会把|把|将).{0,6}(?:你|你的).{0,8}(?:工具调用|工具|能力|功能).{0,10}(?:全删了|删了|删掉|关掉|禁用|移除|废掉)/i,
  /(?:delete|remove|disable|turn off).{0,12}(?:your|the bot'?s).{0,12}(?:tool calls|tools|abilities|capabilities)/i
]);
const SAFETY_BOUNDARY_PATTERNS = Object.freeze([
  /(钓鱼网站|钓鱼页|木马|病毒|勒索软件?|后门|僵尸网络|恶意软件|botnet|malware|ransomware|backdoor|trojan|ddos|sql injection|credential stuffing|bruteforce|brute force|doxx|人肉|诈骗|scam|炸弹|bomb)/i,
  /(?:账号|密码|cookie|凭证|验证码|session|token).{0,10}(?:被盗|泄露|偷|盗|窃取|破解|爆破|绕过)/i,
  /(?:偷|盗|窃取|破解|爆破|绕过).{0,10}(?:账号|密码|cookie|凭证|验证码|session|token|wifi|登录|二步验证|双重验证|2fa|mfa)/i,
  /(刷屏|连发|轰炸|骚扰|spam|flood|harass)/i,
  /(网络攻击|入侵|攻击链|phish|steal|exploit|bypass|hack)/i
]);

function matchesAnyPattern(text = '', patterns = []) {
  const t = String(text || '');
  return patterns.some((pattern) => pattern.test(t));
}

function hasSafetyExemptContext(text = '') {
  return SAFETY_EXEMPT_PATTERN.test(String(text || '').trim());
}

function detectExplicitHarmfulRequest(text = '') {
  const t = String(text || '').trim();
  if (!t) return { matched: false };
  if (hasSafetyExemptContext(t)) return { matched: false };
  const asksToBuildMaliciousArtifact = HARMFUL_ARTIFACT_BUILD_PATTERN.test(t) && HARMFUL_MALICIOUS_ARTIFACT_PATTERN.test(t);
  const asksToStealOrBypass = HARMFUL_STEAL_OR_BYPASS_PATTERN.test(t) && matchesAnyPattern(t, HARMFUL_ACCOUNT_TARGET_PATTERNS);
  if (asksToBuildMaliciousArtifact || asksToStealOrBypass) {
    return { matched: true, reason: 'harmful-request' };
  }
  return { matched: false };
}

function detectExplicitBadFaithRequest(text = '') {
  const t = String(text || '').trim();
  if (!t) return { matched: false };
  if (matchesAnyPattern(t, BAD_FAITH_PATTERNS)) {
    return { matched: true, reason: 'bad-faith-request' };
  }
  return { matched: false };
}

function detectSafetyBoundaryCaution(text = '') {
  const t = String(text || '').trim();
  if (!t) return false;
  if (detectExplicitHarmfulRequest(t).matched || detectExplicitBadFaithRequest(t).matched) return false;
  return matchesAnyPattern(t, SAFETY_BOUNDARY_PATTERNS);
}

function shouldIgnoreUnsafeOrBadFaithRequest(text = '') {
  const t = String(text || '').trim();
  if (!t) return { matched: false };

  const harmfulDecision = detectExplicitHarmfulRequest(t);
  if (harmfulDecision.matched) return harmfulDecision;

  const badFaithDecision = detectExplicitBadFaithRequest(t);
  if (badFaithDecision.matched) return badFaithDecision;

  return { matched: false };
}

module.exports = {
  SAFETY_EXEMPT_PATTERN,
  HARMFUL_MALICIOUS_ARTIFACT_PATTERN,
  HARMFUL_ARTIFACT_BUILD_PATTERN,
  HARMFUL_STEAL_OR_BYPASS_PATTERN,
  HARMFUL_ACCOUNT_TARGET_PATTERNS,
  BAD_FAITH_PATTERNS,
  SAFETY_BOUNDARY_PATTERNS,
  matchesAnyPattern,
  hasSafetyExemptContext,
  detectExplicitHarmfulRequest,
  detectExplicitBadFaithRequest,
  detectSafetyBoundaryCaution,
  shouldIgnoreUnsafeOrBadFaithRequest
};
