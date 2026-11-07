/** Realistic Companies House API responses for tests. No real people; shapes follow the public API. */
export function profile(n: string, o: Record<string, unknown> = {}) {
  return {
    company_name: `TEST COMPANY ${n} LIMITED`,
    company_number: n,
    company_status: "active",
    type: "ltd",
    date_of_creation: "2015-03-02",
    registered_office_address: {
      address_line_1: "1 Test Street",
      locality: "Manchester",
      postal_code: "m1 1aa",
      country: "England",
    },
    sic_codes: ["62012"],
    accounts: {
      last_accounts: { made_up_to: "2025-03-31", type: "micro-entity" },
      next_due: "2026-12-31",
      overdue: false,
    },
    confirmation_statement: {
      next_due: "2027-03-16",
      overdue: false,
      last_made_up_to: "2026-03-02",
    },
    has_insolvency_history: false,
    has_been_liquidated: false,
    has_charges: true,
    undeliverable_registered_office_address: false,
    registered_office_is_in_dispute: false,
    links: { self: `/company/${n}` },
    etag: "abc",
    can_file: true,
    ...o,
  };
}

export function officers() {
  return {
    items: [
      {
        name: "TESTER, Alex",
        officer_role: "director",
        appointed_on: "2015-03-02",
        date_of_birth: { month: 4, year: 1980 },
      },
      {
        name: "EXAMPLE, Sam",
        officer_role: "director",
        appointed_on: "2024-09-01",
        date_of_birth: { month: 7, year: 1990 },
      },
      {
        name: "FORMER, Jo",
        officer_role: "secretary",
        appointed_on: "2016-01-10",
        resigned_on: "2025-02-01",
      },
    ],
    total_results: 3,
    active_count: 2,
    resigned_count: 1,
  };
}

export function filings() {
  return {
    items: [
      { transaction_id: "t1", date: "2015-03-02", category: "incorporation", type: "NEWINC" },
      {
        transaction_id: "t2",
        date: "2016-01-20",
        category: "officers",
        type: "AP03",
        action_date: "2016-01-10",
      },
      {
        transaction_id: "t3",
        date: "2024-09-14",
        category: "officers",
        type: "AP01",
        action_date: "2024-09-01",
        description_values: { appointment_date: "2024-09-01" },
      },
      // Resignation filing lodged two weeks after it took effect.
      {
        transaction_id: "t4",
        date: "2025-02-15",
        category: "officers",
        type: "TM02",
        description_values: { termination_date: "2025-02-01" },
      },
      {
        transaction_id: "t5",
        date: "2025-11-20",
        category: "accounts",
        type: "AA",
        description_values: { made_up_date: "2025-03-31" },
      },
      {
        transaction_id: "t6",
        date: "2026-03-10",
        category: "confirmation-statement",
        type: "CS01",
      },
      { transaction_id: "t7", date: "2025-06-05", category: "mortgage", type: "MR01" },
    ],
    total_count: 7,
  };
}

export function charges() {
  return {
    items: [
      {
        charge_code: "012345670001",
        charge_number: 1,
        created_on: "2025-06-01",
        delivered_on: "2025-06-05",
        status: "outstanding",
      },
    ],
    total_count: 1,
  };
}

export function psc() {
  return {
    items: [
      {
        name: "Mr Alex Tester",
        kind: "individual-person-with-significant-control",
        natures_of_control: ["ownership-of-shares-75-to-100-percent"],
        notified_on: "2016-04-06",
      },
    ],
    total_results: 1,
  };
}

/** A fake fetch serving the fixtures for any company number. */
export function fakeChFetch(o: { notFound?: Set<string>; calls?: string[] } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    o.calls?.push(url.pathname + url.search);
    const m = url.pathname.match(/^\/company\/([A-Z0-9]{8})(\/[a-z-]+)?$/);
    if (!m || o.notFound?.has(m[1] as string)) return new Response("{}", { status: 404 });
    const n = m[1] as string;
    const body =
      m[2] === undefined
        ? profile(n)
        : m[2] === "/officers"
          ? officers()
          : m[2] === "/filing-history"
            ? filings()
            : m[2] === "/charges"
              ? charges()
              : m[2] === "/persons-with-significant-control"
                ? psc()
                : null;
    return body ? Response.json(body) : new Response("{}", { status: 404 });
  }) as typeof fetch;
}
