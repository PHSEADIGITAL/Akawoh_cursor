export default function HomePage() {
  return (
    <section className="grid">
      <div className="card col-12">
        <h1>Akawo Fintech Savings App — MVP</h1>
        <p className="muted">
          Target market: Nigeria. Payments modeled for Paystack webhook deposits and automated payouts.
        </p>
      </div>

      <div className="card col-6">
        <h3>What is implemented</h3>
        <ul>
          <li>Personal locked savings plans with lock-date withdrawal enforcement.</li>
          <li>1.5% platform fee on personal withdrawals, capped at 10,000.</li>
          <li>Group circles with monthly allocation, carry-over, and payout automation.</li>
          <li>1.5% fee on group payouts, capped at 10,000, routed to owner revenue ledger.</li>
          <li>Push invite model: creator searches by phone and sends invite for user acknowledgment.</li>
          <li>Admin revenue panel with fee breakdown and owner account tracking.</li>
        </ul>
      </div>

      <div className="card col-6">
        <h3>How to use</h3>
        <ol>
          <li>Open Dashboard and select a user.</li>
          <li>Create a savings plan, make deposits, and test withdrawal behavior.</li>
          <li>Create a group from Groups page and invite users by phone number.</li>
          <li>Invitee accepts in Dashboard (acknowledgment required before joining).</li>
          <li>Run monthly allocation and payout from Groups page.</li>
          <li>Open Admin Revenue for fee tracking.</li>
        </ol>
      </div>
    </section>
  );
}
