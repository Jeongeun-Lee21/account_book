"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type Expense = {
  id: string;
  date: string;
  amount: number;
  description: string;
  created_at?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

const WELCOME_MESSAGE =
  "안녕하세요! AI 가계부 챗봇입니다.\n\n지출 기록: 오늘 점심 12000원\n통계 질문: 이번 달 총 지출이 얼마야?";

const CHAT_STORAGE_KEY = "ai-account-book-chat";

function createWelcomeMessage(): ChatMessage {
  return { id: createId(), role: "assistant", content: WELCOME_MESSAGE };
}

function loadStoredMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [createWelcomeMessage()];

    const saved = JSON.parse(raw) as ChatMessage[];
    if (!Array.isArray(saved) || saved.length === 0) return [createWelcomeMessage()];

    return saved.filter(
      (item) =>
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string" &&
        item.content.trim(),
    );
  } catch {
    return [createWelcomeMessage()];
  }
}

function formatAmount(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function createId() {
  return crypto.randomUUID();
}

export default function Home() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([createWelcomeMessage()]);
  const [chatReady, setChatReady] = useState(false);
  const [input, setInput] = useState("");
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const isNearBottom = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  }, []);

  const handleChatScroll = useCallback(() => {
    shouldAutoScrollRef.current = isNearBottom();
  }, [isNearBottom]);

  const loadExpenses = useCallback(async () => {
    const { data, error: fetchError } = await supabase
      .from("expenses")
      .select("id, date, amount, description, created_at")
      .order("created_at", { ascending: false });

    if (fetchError) {
      setError(fetchError.message);
      setExpenses([]);
    } else {
      setError(null);
      setExpenses((data as Expense[]) ?? []);
    }

    setReady(true);
  }, []);

  useEffect(() => {
    void loadExpenses();
  }, [loadExpenses]);

  useEffect(() => {
    setMessages(loadStoredMessages());
    setChatReady(true);
  }, []);

  useEffect(() => {
    if (!chatReady) return;
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages));
  }, [messages, chatReady]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    scrollToBottom(messages.length <= 2 ? "auto" : "smooth");
  }, [messages, sending, scrollToBottom]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = input.trim();
    if (!trimmed || sending) return;

    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content: trimmed,
    };

    const history = messages
      .slice(1)
      .map(({ role, content }) => ({ role, content }));

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setSending(true);
    setError(null);
    shouldAutoScrollRef.current = true;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          history,
          expenses: expenses.map(({ date, amount, description }) => ({
            date,
            amount,
            description,
          })),
        }),
      });

      const data = (await response.json()) as {
        reply?: string;
        saved?: boolean;
        expense?: Expense | null;
        error?: string;
      };

      if (!response.ok) {
        setError(data.error || "요청 처리에 실패했습니다.");
      }

      setMessages((prev) => [
        ...prev,
        {
          id: createId(),
          role: "assistant",
          content:
            data.reply ||
            (response.ok ? "알겠습니다." : "죄송합니다. 다시 시도해 주세요."),
        },
      ]);

      if (data.saved && data.expense) {
        setExpenses((prev) => [data.expense as Expense, ...prev]);
        void loadExpenses();
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "메시지 전송에 실패했습니다.";
      setError(message);
      setMessages((prev) => [
        ...prev,
        {
          id: createId(),
          role: "assistant",
          content: "네트워크 오류가 발생했어요. 연결을 확인하고 다시 시도해 주세요.",
        },
      ]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  const total = expenses.reduce((sum, item) => sum + item.amount, 0);

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="shrink-0 border-b border-black/[0.06] bg-background px-4 py-4 sm:px-6">
        <h1 className="text-center text-lg font-semibold tracking-tight text-foreground sm:text-xl">
          AI 가계부 챗봇
        </h1>
      </header>

      <section className="shrink-0 border-b border-black/[0.06] bg-surface/50 px-4 py-4 sm:px-6">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">저장된 지출</h2>
          {expenses.length > 0 && (
            <p className="font-mono text-sm tabular-nums text-muted">
              합계 {formatAmount(total)}원
            </p>
          )}
        </div>

        {!ready ? (
          <p className="py-2 text-sm text-muted">불러오는 중…</p>
        ) : expenses.length === 0 ? (
          <p className="py-2 text-sm text-muted">아직 저장된 지출이 없습니다</p>
        ) : (
          <ul className="flex gap-3 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {expenses.map((item) => (
              <li
                key={item.id}
                className="min-w-[168px] shrink-0 rounded-2xl bg-background px-4 py-3"
              >
                <p className="truncate text-[15px] font-medium text-foreground">
                  {item.description}
                </p>
                <p className="mt-1 font-mono text-lg font-medium tabular-nums text-foreground">
                  {formatAmount(item.amount)}
                  <span className="ml-0.5 text-xs font-sans font-normal text-muted">
                    원
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted">{item.date}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={chatScrollRef}
          onScroll={handleChatScroll}
          className="chat-scroll min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 py-5 sm:px-6"
        >
          <div className="mx-auto flex min-h-full max-w-2xl flex-col gap-3 pb-2">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[82%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-[15px] leading-relaxed sm:max-w-[75%] sm:text-base ${
                    message.role === "user"
                      ? "rounded-br-md bg-accent text-white"
                      : "rounded-bl-md bg-surface text-foreground"
                  }`}
                >
                  {message.content}
                </div>
              </div>
            ))}

            {sending && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-md bg-surface px-4 py-3 text-[15px] text-muted">
                  입력 중…
                </div>
              </div>
            )}
          </div>
        </div>

        {error && (
          <p className="shrink-0 px-4 pb-2 text-center text-sm text-muted sm:px-6">
            {error}
          </p>
        )}

        <form
          onSubmit={handleSubmit}
          className="shrink-0 border-t border-black/[0.06] bg-background px-4 py-3 sm:px-6 sm:py-4"
        >
          <div className="mx-auto flex max-w-2xl items-end gap-2 sm:gap-3">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="지출 내용을 입력하세요"
              disabled={sending}
              className="min-h-12 flex-1 rounded-2xl bg-surface px-4 text-base text-foreground outline-none transition placeholder:text-muted/80 focus:ring-2 focus:ring-foreground/10 disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={sending || !input.trim()}
              className="min-h-12 shrink-0 rounded-2xl bg-accent px-5 text-[15px] font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40 sm:px-6"
            >
              전송
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
