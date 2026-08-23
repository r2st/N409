-- The invoices a `DELETE FROM users` would take with it.
--
-- Nothing in this codebase hard-deletes a user or a valuation. `deleteUser`
-- sets `deleted_at`, SCIM deprovision sets `deleted_at`, the retention sweep
-- retires valuations by setting `archived_at`, and the org delete refuses
-- outright when a roll-up still needs the subsidiary. So the three ledger
-- tables have never actually lost a row, and the cascades below have never
-- fired.
--
-- That is the whole of the protection, and it is not written down anywhere a
-- migration can read. `invoices.user_id` and `subscriptions.user_id` are
-- `ON DELETE CASCADE`; `payments.valuation_id` is too. One `DELETE FROM users
-- WHERE id = ...` typed at a psql prompt — the shape of every GDPR erasure
-- request that has ever been handled by hand — silently destroys that user's
-- invoices and their subscription history, and the statement returns
-- `DELETE 1` as if it had done what it said.
--
-- Invoices are the sharp case. `invoices.number` is `NOT NULL UNIQUE` and is
-- drawn from `invoice_sequences`, which is not decremented and could not be:
-- a deleted invoice leaves a permanent hole in a numbered series that exists
-- precisely so there are no holes in it. There is no repair after the fact,
-- because the rows that said what the numbers were are the rows that went.
--
-- The schema already disagrees with itself about this. `payments.created_by`
-- references `users` with no delete action at all, so a user with a payment to
-- their name cannot be deleted — while the same user's invoices would go
-- without a word. Same table family, same question, two answers, and the
-- stricter one is on the column that matters less.
--
-- RESTRICT rather than the implicit NO ACTION every other guarded FK carries,
-- because these three are the ones where the difference in intent is worth
-- reading in a `\d`: "this row outlives its owner" as a stated property, not
-- as the absence of a clause. The practical effect is the same — the delete is
-- refused — except that RESTRICT cannot be deferred past the statement.
--
-- What this does NOT do is make a user undeletable. Everything a user
-- accumulates that is not a record of money still cascades: sessions, MFA
-- enrolments, saved views, notification preferences, comment reads. The
-- refusal is specific, and it names the reason in the error.

ALTER TABLE invoices
  DROP CONSTRAINT invoices_user_id_fkey,
  ADD CONSTRAINT invoices_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE subscriptions
  DROP CONSTRAINT subscriptions_user_id_fkey,
  ADD CONSTRAINT subscriptions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE payments
  DROP CONSTRAINT payments_valuation_id_fkey,
  ADD CONSTRAINT payments_valuation_id_fkey
    FOREIGN KEY (valuation_id) REFERENCES valuations(id) ON DELETE RESTRICT;
