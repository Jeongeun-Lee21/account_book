import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ExpenseInput = {
  date: string;
  amount: number;
  description: string;
};

type GeminiResponse = {
  reply: string;
  expense: ExpenseInput | null;
};

type MessageIntent = "expense" | "question" | "general";

const GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-flash-latest"] as const;
const MODEL_TIMEOUT_MS = 15_000;
const MAX_HISTORY = 8;
const MAX_EXPENSES_IN_PROMPT = 8;
const MAX_EXPENSES_FOR_STATS = 500;

function sanitizeHistory(history: ChatMessage[]): ChatMessage[] {
  const trimmed = history.filter((item) => item.content?.trim());

  let start = 0;
  while (start < trimmed.length && trimmed[start].role === "assistant") {
    start += 1;
  }

  const valid: ChatMessage[] = [];
  for (const item of trimmed.slice(start)) {
    if (valid.length === 0 && item.role !== "user") continue;
    if (valid.at(-1)?.role === item.role) continue;
    valid.push(item);
  }

  return valid.slice(-MAX_HISTORY);
}

function isRetryableModelError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("404") ||
    message.includes("no longer available") ||
    message.includes("not found") ||
    message.includes("timeout")
  );
}

function parseGeminiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("API key not valid") || message.includes("API_KEY_INVALID")) {
    return "Gemini API 키가 올바르지 않습니다. .env.local의 GEMINI_API_KEY를 확인해 주세요.";
  }

  if (message.includes("is no longer available") || message.includes("[404 ]")) {
    return "사용 중인 Gemini 모델을 더 이상 지원하지 않습니다. 잠시 후 다시 시도해 주세요.";
  }

  if (message.includes("timeout")) {
    return "AI 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.";
  }

  if (message.includes("GoogleGenerativeAI")) {
    return `AI 서비스 오류: ${message.replace(/\[GoogleGenerativeAI Error\]:?\s*/i, "")}`;
  }

  return message;
}

function todayString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isValidDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function isValidExpense(expense: ExpenseInput | null | undefined): expense is ExpenseInput {
  return (
    !!expense &&
    isValidDate(expense.date) &&
    !!expense.description?.trim() &&
    Number.isFinite(expense.amount) &&
    expense.amount > 0
  );
}

type MissingField = "date" | "amount" | "description";

function getMissingFields(expense: ExpenseInput | null | undefined): MissingField[] {
  const missing: MissingField[] = [];

  if (!expense?.date?.trim() || !isValidDate(expense.date)) {
    missing.push("date");
  }
  if (!expense || !Number.isFinite(expense.amount) || expense.amount <= 0) {
    missing.push("amount");
  }
  if (!expense?.description?.trim()) {
    missing.push("description");
  }

  return missing;
}

function refineMissingFields(
  message: string,
  expense: ExpenseInput | null | undefined,
): MissingField[] {
  const missing = getMissingFields(expense);
  const text = message.trim();

  const hasDateHint =
    /오늘|어제|그저께|\d{4}-\d{2}-\d{2}|\d{1,2}\s*월\s*\d{1,2}\s*일/.test(text);
  const hasAmountHint = /\d[\d,]*\s*원?|\d+\s*만|\d+\s*천|[0-9]{4,}/.test(text);
  const hasDescHint =
    /점심|저녁|아침|택시|커피|식사|교통|쇼핑|마트|구매|간식|술|약|병원|영화|밥/.test(text);

  return missing.filter((field) => {
    if (field === "date" && hasDateHint) return false;
    if (field === "amount" && hasAmountHint) return false;
    if (field === "description" && hasDescHint) return false;
    return true;
  });
}

function buildClarificationReply(missing: MissingField[]): string {
  if (missing.length >= 3) {
    return "지출을 저장하려면 날짜, 금액, 내용이 필요해요.\n예: 어제 택시 20000원 / 오늘 점심 15000원";
  }

  if (missing.length === 1) {
    const messages: Record<MissingField, string> = {
      date: "언제 지출하셨는지 알려주실 수 있을까요?\n예: 어제 / 오늘 / 8월 28일",
      amount: "금액을 알려주실 수 있을까요?\n예: 15000원 / 2만원",
      description: "어떤 지출인지 알려주실 수 있을까요?\n예: 점심 / 택시 / 커피",
    };
    return messages[missing[0]];
  }

  const labels: Record<MissingField, string> = {
    date: "날짜",
    amount: "금액",
    description: "내용",
  };

  const fields = missing.map((field) => labels[field]).join(", ");
  return `${fields}을(를) 알 수 없어요. 다시 알려주실 수 있을까요?\n예: 오늘 점심 15000원`;
}

function looksLikeExpenseIntent(message: string): boolean {
  const text = message.trim();
  const hasAmount =
    /\d[\d,]*\s*원?|\d+\s*만|\d+\s*천|원\s*$|[0-9]{3,}/.test(text);
  const hasExpenseKeyword =
    /점심|저녁|아침|택시|커피|식사|교통|쇼핑|마트|구매|결제|지출|썼|냈|탔|먹었|마셨|샀|어제|오늘|그저께|밥|간식|술|약|병원|영화/.test(
      text,
    );

  return hasAmount || hasExpenseKeyword;
}

function detectIntent(message: string): MessageIntent {
  const text = message.trim();

  const hasQuestionWord =
    /얼마|뭐|무엇|어떻게|몇\s*원|몇\s*개|알려|보여|총|합계|가장|제일|많이|적게|비교|통계|분석|샀더라|지출이|지출은|지난|이번\s*달|지난주|식비|교통비|언제|어디|무슨|얼마나|평균|순위|목록|내역|리스트/.test(
      text,
    );
  const hasQuestionMark = /[?？]/.test(text);

  if (hasQuestionWord || hasQuestionMark) {
    return "question";
  }

  const hasAmount = /\d[\d,]*\s*원?|\d+\s*만|\d+\s*천|[0-9]{3,}/.test(text);
  if (hasAmount) {
    return "expense";
  }

  if (looksLikeExpenseIntent(text)) {
    return "expense";
  }

  return "general";
}

function resolveExpenseResponse(
  message: string,
  parsed: GeminiResponse,
): GeminiResponse {
  if (isValidExpense(parsed.expense)) {
    return parsed;
  }

  const missing = refineMissingFields(message, parsed.expense);
  const shouldAsk =
    parsed.expense !== null || looksLikeExpenseIntent(message);

  if (shouldAsk && missing.length > 0) {
    return {
      reply: buildClarificationReply(missing),
      expense: null,
    };
  }

  return {
    reply: parsed.reply,
    expense: null,
  };
}

function buildExpenseSystemPrompt(expenses: ExpenseInput[]) {
  const expenseSummary =
    expenses.length === 0
      ? "없음"
      : expenses
          .slice(0, MAX_EXPENSES_IN_PROMPT)
          .map(
            (item) =>
              `${item.date} ${item.amount.toLocaleString("ko-KR")}원 ${item.description}`,
          )
          .join(" | ");

  return `한국어 AI 가계부. 오늘: ${todayString()}
지출 기록 요청일 때 date(YYYY-MM-DD), amount(정수), description을 추출합니다.
"2만원"→20000, "오늘/어제"→날짜 계산.

중요 규칙:
- date, amount, description 중 하나라도 확실하지 않으면 절대 추측하지 마세요.
- 불확실하면 expense는 반드시 null이고, reply에서 부족한 정보를 다시 물어보세요.
- 저장은 세 가지가 모두 확실할 때만 합니다.

최근 지출: ${expenseSummary}

JSON만 출력:
일반 대화: {"reply":"한국어 응답","expense":null}
정보 부족: {"reply":"부족한 정보를 다시 질문","expense":null}
저장 가능: {"reply":"M월 D일 {내용} {금액}원을 저장했어요!","expense":{"date":"YYYY-MM-DD","amount":숫자,"description":"내용"}}`;
}

function buildStatsSystemPrompt(expenses: ExpenseInput[]) {
  const truncated = expenses.length > MAX_EXPENSES_FOR_STATS;
  const list = expenses.slice(0, MAX_EXPENSES_FOR_STATS);

  const expenseData =
    list.length === 0
      ? "(저장된 지출 없음)"
      : list
          .map(
            (item) =>
              `- ${item.date} | ${item.amount.toLocaleString("ko-KR")}원 | ${item.description}`,
          )
          .join("\n");

  const truncateNote = truncated
    ? `\n(최근 ${MAX_EXPENSES_FOR_STATS}건만 표시, 전체 ${expenses.length}건)`
    : "";

  return `한국어 AI 가계부 통계 분석 도우미. 오늘: ${todayString()}

아래 Supabase 지출 데이터를 바탕으로 사용자 질문에 답하세요.
- 친근하고 자연스러운 한국어로 답변
- 금액은 천 단위 콤마 (예: 45,000원)
- 데이터에 없는 내용은 추측하지 말고 "기록이 없어요"라고 안내
- 이번 달/지난주/어제 등 기간은 오늘 날짜 기준으로 계산
- 항목별·카테고리별 집계는 description 키워드로 유추 (식비: 점심, 저녁, 식사, 커피, 밥 등)

지출 데이터 (날짜 내림차순):
${expenseData}${truncateNote}

JSON만 출력: {"reply":"친근한 한국어 답변","expense":null}`;
}

function parseGeminiText(text: string): GeminiResponse {
  try {
    const parsed = JSON.parse(text) as GeminiResponse;
    return {
      reply: parsed.reply?.trim() || "알겠습니다.",
      expense: parsed.expense ?? null,
    };
  } catch {
    return {
      reply: "응답을 처리하지 못했습니다. 다시 말씀해 주세요.",
      expense: null,
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("Gemini request timeout")), ms),
    ),
  ]);
}

async function callGemini(
  apiKey: string,
  message: string,
  history: ChatMessage[],
  systemInstruction: string,
): Promise<GeminiResponse> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const sanitizedHistory = sanitizeHistory(history);
  let lastError: unknown;

  for (const modelName of GEMINI_MODELS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction,
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 512,
        },
      });

      const contents = [
        ...sanitizedHistory.map((item) => ({
          role: item.role === "assistant" ? ("model" as const) : ("user" as const),
          parts: [{ text: item.content }],
        })),
        { role: "user" as const, parts: [{ text: message.trim() }] },
      ];

      const result = await withTimeout(model.generateContent({ contents }), MODEL_TIMEOUT_MS);
      return parseGeminiText(result.response.text());
    } catch (error) {
      lastError = error;
      if (!isRetryableModelError(error)) break;
    }
  }

  throw lastError ?? new Error("Gemini API 호출에 실패했습니다.");
}

async function fetchAllExpenses(): Promise<ExpenseInput[]> {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("expenses")
    .select("date, amount, description")
    .order("date", { ascending: false });

  if (error) {
    throw new Error(`지출 데이터를 불러오지 못했습니다: ${error.message}`);
  }

  return (data as ExpenseInput[]) ?? [];
}

export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY가 설정되지 않았습니다." },
      { status: 500 },
    );
  }

  try {
    const body = (await request.json()) as {
      message: string;
      history?: ChatMessage[];
      expenses?: ExpenseInput[];
    };

    const { message, history = [], expenses = [] } = body;

    if (!message?.trim()) {
      return NextResponse.json({ error: "메시지를 입력해 주세요." }, { status: 400 });
    }

    const intent = detectIntent(message);

    if (intent === "question") {
      const allExpenses = await fetchAllExpenses();
      const parsed = await callGemini(
        apiKey,
        message,
        history,
        buildStatsSystemPrompt(allExpenses),
      );

      return NextResponse.json({
        reply: parsed.reply,
        saved: false,
        expense: null,
      });
    }

    const parsed = resolveExpenseResponse(
      message,
      await callGemini(apiKey, message, history, buildExpenseSystemPrompt(expenses)),
    );

    if (!isValidExpense(parsed.expense)) {
      return NextResponse.json({
        reply: parsed.reply,
        saved: false,
        expense: null,
      });
    }

    const supabase = createServerSupabaseClient();
    const { data, error: insertError } = await supabase
      .from("expenses")
      .insert({
        date: parsed.expense.date,
        amount: Math.round(parsed.expense.amount),
        description: parsed.expense.description.trim(),
      })
      .select("id, date, amount, description, created_at")
      .single();

    if (insertError) {
      return NextResponse.json(
        {
          error: `저장에 실패했습니다: ${insertError.message}`,
          reply: "지출을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.",
          saved: false,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      reply: parsed.reply,
      saved: true,
      expense: data,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: parseGeminiError(error),
        reply: "죄송합니다. 일시적인 오류가 발생했어요. 잠시 후 다시 시도해 주세요.",
        saved: false,
      },
      { status: 500 },
    );
  }
}
