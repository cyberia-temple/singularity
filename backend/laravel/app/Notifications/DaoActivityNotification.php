<?php

namespace App\Notifications;

/**
 * DAO activity (new DAO, proposal, comment, vote, reaction) — a
 * `CommunityNotification` under its own class so the bell and the tests can
 * tell governance apart from the rest.
 */
class DaoActivityNotification extends CommunityNotification {}
