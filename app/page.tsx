"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Expense = {
  id: string;
  date: string;
  amount: number;
  description: string;
  created_at?: string;
};

function formatAmount(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

const fieldClassName =
  "h-14 w-full rounded-xl bg-background px-4 text-base text-foreground outline-none transition placeholder:text-muted/80 focus:ring-2 focus:ring-foreground/10 sm:h-12 sm:text-[15px]";

export default function Home() {
  const [date, setDate] = useState(todayString);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const parsedAmount = Number(amount.replace(/,/g, ""));
    if (!date || !description.trim() || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return;
    }

    setSaving(true);
    setError(null);

    const { error: insertError } = await supabase.from("expenses").insert({
      date,
      amount: parsedAmount,
      description: description.trim(),
    });

    setSaving(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    setAmount("");
    setDescription("");
    setDate(todayString());
    await loadExpenses();
  }

  async function handleDelete(id: string) {
    setError(null);
    const { error: deleteError } = await supabase.from("expenses").delete().eq("id", id);

    if (deleteError) {
      setError(deleteError.message);
      return;
    }

    setExpenses((prev) => prev.filter((item) => item.id !== id));
  }

  const total = expenses.reduce((sum, item) => sum + item.amount, 0);

  return (
    <div className="flex min-h-full flex-1 flex-col bg-background">
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col px-5 py-12 sm:px-8 sm:py-20">
        <header className="mb-12 sm:mb-16">
          <h1 className="text-[2rem] font-semibold tracking-tight text-foreground sm:text-4xl">
            나의 스마트 가계부
          </h1>
          <p className="mt-3 text-base leading-relaxed text-muted sm:text-[17px]">
            지출을 기록하고 한눈에 살펴보세요
          </p>
        </header>

        <form
          onSubmit={handleSubmit}
          className="w-full rounded-2xl bg-surface p-6 sm:p-8"
        >
          <div className="flex flex-col gap-8 sm:gap-7">
            <label className="flex flex-col gap-2.5">
              <span className="text-[15px] font-medium text-foreground sm:text-sm">
                날짜
              </span>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                className={fieldClassName}
              />
            </label>

            <label className="flex flex-col gap-2.5">
              <span className="text-[15px] font-medium text-foreground sm:text-sm">
                금액
              </span>
              <div className="relative">
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                  className={`${fieldClassName} pr-12 font-mono tabular-nums`}
                />
                <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[15px] text-muted">
                  원
                </span>
              </div>
            </label>

            <label className="flex flex-col gap-2.5">
              <span className="text-[15px] font-medium text-foreground sm:text-sm">
                내용
              </span>
              <input
                type="text"
                placeholder="예: 점심 식사, 교통비"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
                maxLength={80}
                className={fieldClassName}
              />
            </label>

            <button
              type="submit"
              disabled={saving}
              className="mt-1 min-h-14 w-full rounded-xl bg-accent text-[17px] font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-12 sm:text-[15px]"
            >
              {saving ? "저장 중…" : "저장하기"}
            </button>
          </div>
        </form>

        {error && (
          <p className="mt-6 text-[15px] leading-relaxed text-muted">
            {error}
          </p>
        )}

        <section className="mt-14 flex w-full flex-1 flex-col sm:mt-16">
          <div className="mb-6 flex items-baseline justify-between gap-4 sm:mb-8">
            <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              지출 내역
            </h2>
            {expenses.length > 0 && (
              <p className="font-mono text-xl font-medium tabular-nums tracking-tight text-foreground sm:text-2xl">
                {formatAmount(total)}
                <span className="ml-0.5 text-base font-sans font-normal text-muted sm:text-lg">
                  원
                </span>
              </p>
            )}
          </div>

          {!ready ? (
            <p className="py-12 text-center text-[15px] text-muted">
              불러오는 중…
            </p>
          ) : expenses.length === 0 ? (
            <p className="py-12 text-center text-[15px] text-muted">
              아직 저장된 지출이 없습니다
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {expenses.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-4 rounded-2xl bg-surface px-5 py-5 sm:px-6 sm:py-5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[17px] font-medium leading-snug text-foreground sm:text-base">
                      {item.description}
                    </p>
                    <p className="mt-1.5 text-sm text-muted">{item.date}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 sm:gap-4">
                    <span className="font-mono text-xl font-medium tabular-nums tracking-tight text-foreground sm:text-[1.35rem]">
                      {formatAmount(item.amount)}
                      <span className="ml-0.5 text-sm font-sans font-normal text-muted">
                        원
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleDelete(item.id)}
                      className="min-h-11 min-w-11 rounded-lg text-sm text-muted transition-colors hover:text-foreground sm:min-h-0 sm:min-w-0"
                      aria-label={`${item.description} 삭제`}
                    >
                      삭제
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
