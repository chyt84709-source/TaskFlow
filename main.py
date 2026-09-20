import tkinter as tk
from tkinter import messagebox, ttk


class TaskFlowApp(tk.Tk):
    """Local prototype for a video-task marketplace and product store."""

    def __init__(self):
        super().__init__()
        self.title("TaskFlow | Earn, sell, grow")
        self.geometry("1220x780")
        self.minsize(1000, 680)
        self.configure(bg="#f4f6f8")
        self.balance = 128.40
        self.watched_seconds = 0
        self.watching = False
        self.tasks = [
            ("A softer morning routine", "Noma Home", 130, "$0.80"),
            ("The 3-minute pantry reset", "Good Table Co.", 180, "$1.10"),
            ("Build a better client brief", "Orbit Studio", 90, "$0.60"),
        ]
        self.transactions = [
            ("Task verified · Noma Home", "+$0.80", "Today", "Verified"),
            ("Store sale · Linen market tote", "+$24.00", "Yesterday", "Paid"),
            ("Payout to Visa •• 4281", "-$80.00", "Sep 17", "Completed"),
        ]
        self._styles()
        self._shell()
        self.show("Overview")

    def _styles(self):
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("App.TFrame", background="#f4f6f8")
        style.configure("Side.TFrame", background="#15231f")
        style.configure("Card.TFrame", background="#ffffff")
        style.configure("Title.TLabel", background="#f4f6f8", foreground="#17211e", font=("Segoe UI", 24, "bold"))
        style.configure("H2.TLabel", background="#ffffff", foreground="#17211e", font=("Segoe UI", 13, "bold"))
        style.configure("Body.TLabel", background="#ffffff", foreground="#61706b", font=("Segoe UI", 10))
        style.configure("Muted.TLabel", background="#f4f6f8", foreground="#71807a", font=("Segoe UI", 10))
        style.configure("Primary.TButton", background="#e0ad4d", foreground="#17211e", padding=(14, 9), font=("Segoe UI", 10, "bold"))
        style.map("Primary.TButton", background=[("active", "#efc970")])
        style.configure("Secondary.TButton", background="#e9efec", foreground="#234238", padding=(12, 8), font=("Segoe UI", 9, "bold"))
        style.map("Secondary.TButton", background=[("active", "#d8e4de")])
        style.configure("TProgressbar", troughcolor="#e5ebe8", background="#e0ad4d", bordercolor="#e5ebe8", lightcolor="#e0ad4d", darkcolor="#e0ad4d")

    def _shell(self):
        sidebar = ttk.Frame(self, style="Side.TFrame", width=235, padding=24)
        sidebar.pack(side="left", fill="y")
        sidebar.pack_propagate(False)
        tk.Label(sidebar, text="TASKFLOW", bg="#15231f", fg="#f0c56a", font=("Segoe UI", 16, "bold")).pack(anchor="w")
        tk.Label(sidebar, text="The work marketplace", bg="#15231f", fg="#aab8b1", font=("Segoe UI", 10)).pack(anchor="w", pady=(2, 34))
        self.nav = {}
        for name in ("Overview", "Watch & earn", "Freelance", "Marketplace", "Wallet", "Transactions", "Profile"):
            button = tk.Button(sidebar, text=name, anchor="w", relief="flat", borderwidth=0, padx=12, pady=11, cursor="hand2", bg="#15231f", fg="#aab8b1", activebackground="#284239", activeforeground="#f0c56a", font=("Segoe UI", 10), command=lambda item=name: self.show(item))
            button.pack(fill="x", pady=2)
            self.nav[name] = button
        tk.Label(sidebar, text="ACCOUNT STATUS", bg="#15231f", fg="#aab8b1", font=("Segoe UI", 9)).pack(anchor="w", pady=(42, 8))
        tk.Label(sidebar, text="Verified creator", bg="#284239", fg="#c9e5d5", padx=10, pady=10, font=("Segoe UI", 9, "bold")).pack(fill="x")
        tk.Label(sidebar, text="v0.1 local prototype", bg="#15231f", fg="#aab8b1", font=("Segoe UI", 9)).pack(side="bottom", anchor="w")
        self.main = ttk.Frame(self, style="App.TFrame", padding=(34, 28))
        self.main.pack(side="left", fill="both", expand=True)

    def _clear(self):
        for child in self.main.winfo_children():
            child.destroy()

    def _header(self, eyebrow, title, subtitle):
        ttk.Label(self.main, text=eyebrow.upper(), style="Muted.TLabel").pack(anchor="w")
        ttk.Label(self.main, text=title, style="Title.TLabel").pack(anchor="w", pady=(4, 2))
        ttk.Label(self.main, text=subtitle, style="Muted.TLabel").pack(anchor="w", pady=(0, 24))

    def _card(self, parent, column, title, value, detail):
        card = ttk.Frame(parent, style="Card.TFrame", padding=18)
        card.grid(row=0, column=column, sticky="nsew", padx=6, pady=6)
        tk.Label(card, text=title.upper(), bg="#ffffff", fg="#71807a", font=("Segoe UI", 9, "bold")).pack(anchor="w")
        tk.Label(card, text=value, bg="#ffffff", fg="#17211e", font=("Segoe UI", 21, "bold")).pack(anchor="w", pady=(8, 2))
        tk.Label(card, text=detail, bg="#ffffff", fg="#61706b", font=("Segoe UI", 9)).pack(anchor="w")

    def show(self, view):
        for name, button in self.nav.items():
            button.configure(bg="#284239" if name == view else "#15231f", fg="#f0c56a" if name == view else "#aab8b1")
        self._clear()
        {"Overview": self._overview, "Watch & earn": self._tasks, "Freelance": self._freelance, "Marketplace": self._marketplace, "Wallet": self._wallet, "Transactions": self._transactions, "Profile": self._profile}[view]()

    def _overview(self):
        self._header("Monday, 20 September", "Good morning, Amina", "Your marketplace activity at a glance.")
        stats = ttk.Frame(self.main, style="App.TFrame")
        stats.pack(fill="x")
        for i in range(4):
            stats.columnconfigure(i, weight=1)
        self._card(stats, 0, "Available balance", f"${self.balance:,.2f}", "+$24.80 this week")
        self._card(stats, 1, "Tasks completed", "38", "8 awaiting review")
        self._card(stats, 2, "Store sales", "12", "$284.00 gross sales")
        self._card(stats, 3, "Trust score", "98%", "Profile verified")
        body = ttk.Frame(self.main, style="App.TFrame")
        body.pack(fill="both", expand=True, pady=(20, 0))
        body.columnconfigure(0, weight=3)
        body.columnconfigure(1, weight=2)
        body.rowconfigure(0, weight=1)
        activity = ttk.Frame(body, style="Card.TFrame", padding=20)
        activity.grid(row=0, column=0, sticky="nsew", padx=(0, 8))
        ttk.Label(activity, text="Recommended tasks", style="H2.TLabel").pack(anchor="w")
        ttk.Label(activity, text="Fresh opportunities matched to your profile", style="Body.TLabel").pack(anchor="w", pady=(3, 16))
        for title, category, pay in [("Make your workspace feel calm", "Lifestyle video  ·  2:10", "$0.80"), ("A 30-second recipe that works", "Food & drink  ·  0:45", "$0.35"), ("How small shops go digital", "Business  ·  1:30", "$0.60")]:
            row = ttk.Frame(activity, style="Card.TFrame")
            row.pack(fill="x", pady=6)
            tk.Label(row, text=title, bg="#ffffff", fg="#17211e", font=("Segoe UI", 10, "bold")).pack(side="left")
            tk.Label(row, text=category, bg="#ffffff", fg="#71807a", font=("Segoe UI", 9)).pack(side="left", padx=14)
            tk.Label(row, text=pay, bg="#ffffff", fg="#b27d19", font=("Segoe UI", 10, "bold")).pack(side="right")
        ttk.Button(activity, text="Browse all tasks", style="Secondary.TButton", command=lambda: self.show("Watch & earn")).pack(anchor="w", pady=(18, 0))
        quick = ttk.Frame(body, style="Card.TFrame", padding=20)
        quick.grid(row=0, column=1, sticky="nsew", padx=(8, 0))
        ttk.Label(quick, text="Quick actions", style="H2.TLabel").pack(anchor="w")
        ttk.Button(quick, text="Start earning", style="Primary.TButton", command=lambda: self.show("Watch & earn")).pack(fill="x", pady=(18, 8))
        ttk.Button(quick, text="Post a video task", style="Secondary.TButton", command=self._post_task).pack(fill="x", pady=4)
        ttk.Button(quick, text="Find freelance work", style="Secondary.TButton", command=lambda: self.show("Freelance")).pack(fill="x", pady=4)
        ttk.Button(quick, text="List a product", style="Secondary.TButton", command=self._list_product).pack(fill="x", pady=4)
        ttk.Button(quick, text="Request payout", style="Secondary.TButton", command=lambda: self.show("Wallet")).pack(fill="x", pady=4)

    def _tasks(self):
        self._header("Earn by watching", "Available tasks", "Watch the required duration. We track progress locally for this prototype.")
        content = ttk.Frame(self.main, style="App.TFrame")
        content.pack(fill="both", expand=True)
        content.columnconfigure(0, weight=3)
        content.columnconfigure(1, weight=2)
        left = ttk.Frame(content, style="Card.TFrame", padding=20)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 8))
        ttk.Label(left, text="Pick a campaign", style="H2.TLabel").pack(anchor="w")
        for title, owner, seconds, reward in self.tasks:
            item = ttk.Frame(left, style="Card.TFrame", padding=12)
            item.pack(fill="x", pady=7)
            tk.Label(item, text=title, bg="#ffffff", fg="#17211e", font=("Segoe UI", 10, "bold")).pack(anchor="w")
            tk.Label(item, text=f"{owner}  ·  {seconds // 60}m {seconds % 60:02d}s  ·  Earn {reward}", bg="#ffffff", fg="#71807a", font=("Segoe UI", 9)).pack(anchor="w", pady=(4, 8))
            ttk.Button(item, text="Watch task", style="Secondary.TButton", command=lambda t=title, s=seconds, r=reward: self._start_task(t, s, r)).pack(anchor="w")
        right = ttk.Frame(content, style="Card.TFrame", padding=20)
        right.grid(row=0, column=1, sticky="nsew", padx=(8, 0))
        ttk.Label(right, text="Watch verification", style="H2.TLabel").pack(anchor="w")
        self.task_title = ttk.Label(right, text="No task selected", style="Body.TLabel")
        self.task_title.pack(anchor="w", pady=(16, 4))
        self.task_timer = tk.Label(right, text="00:00 / 00:00", bg="#ffffff", fg="#17211e", font=("Segoe UI", 24, "bold"))
        self.task_timer.pack(anchor="w", pady=(8, 12))
        self.task_progress = ttk.Progressbar(right, maximum=100)
        self.task_progress.pack(fill="x")
        self.task_state = ttk.Label(right, text="Select a task to begin", style="Body.TLabel")
        self.task_state.pack(anchor="w", pady=(10, 16))
        self.task_button = ttk.Button(right, text="Start watching", style="Primary.TButton", state="disabled", command=self._toggle_watch)
        self.task_button.pack(fill="x")
        ttk.Label(right, text="Progress is only credited after the full watch duration is reached.", style="Body.TLabel", wraplength=270).pack(anchor="w", pady=(24, 0))

    def _start_task(self, title, seconds, reward):
        self.selected_task = (title, seconds, reward)
        self.watched_seconds = 0
        self.watching = False
        self.task_title.configure(text=title)
        self.task_timer.configure(text=f"00:00 / {seconds // 60:02d}:{seconds % 60:02d}")
        self.task_progress.configure(value=0)
        self.task_state.configure(text=f"Reward on completion: {reward}")
        self.task_button.configure(state="normal", text="Start watching")

    def _toggle_watch(self):
        self.watching = not self.watching
        self.task_button.configure(text="Pause watch" if self.watching else "Resume watch")
        if self.watching:
            self._tick_watch()

    def _tick_watch(self):
        if not self.watching:
            return
        title, seconds, reward = self.selected_task
        self.watched_seconds += 1
        percent = min(100, self.watched_seconds / seconds * 100)
        self.task_progress.configure(value=percent)
        self.task_timer.configure(text=f"{self.watched_seconds // 60:02d}:{self.watched_seconds % 60:02d} / {seconds // 60:02d}:{seconds % 60:02d}")
        if self.watched_seconds >= seconds:
            self.watching = False
            self.balance += float(reward.replace("$", ""))
            self.task_state.configure(text=f"Verified. {reward} added to your wallet.")
            self.transactions.insert(0, (f"Task verified · {title}", f"+{reward}", "Just now", "Verified"))
            self.task_button.configure(text="Task complete", state="disabled")
        else:
            self.after(1000, self._tick_watch)

    def _marketplace(self):
        self._header("Buy and sell", "Marketplace", "Discover useful goods from independent makers, or put your own work on the shelf.")
        toolbar = ttk.Frame(self.main, style="App.TFrame")
        toolbar.pack(fill="x", pady=(0, 12))
        ttk.Button(toolbar, text="+ List a product", style="Primary.TButton", command=self._list_product).pack(side="right")
        grid = ttk.Frame(self.main, style="App.TFrame")
        grid.pack(fill="both", expand=True)
        for i in range(3):
            grid.columnconfigure(i, weight=1)
        products = [("Hand-thrown stoneware mug", "Mara Ceramics", "$28", "HOME"), ("Brand voice starter kit", "North Studio", "$42", "DIGITAL"), ("Linen market tote", "Field Notes Goods", "$24", "LIFESTYLE"), ("Custom invoice template", "Amina Designs", "$15", "DIGITAL"), ("Weekend print set", "Pine & Ink", "$18", "ART")]
        colors = ["#d9e4dd", "#eadfc9", "#d7e1e6", "#e5d8d4", "#e4e0c9"]
        for index, (name, seller, price, tag) in enumerate(products):
            card = ttk.Frame(grid, style="Card.TFrame", padding=14)
            card.grid(row=index // 3, column=index % 3, sticky="nsew", padx=6, pady=6)
            swatch = tk.Canvas(card, height=96, bg=colors[index], highlightthickness=0)
            swatch.pack(fill="x", pady=(0, 12))
            swatch.create_text(12, 14, text=tag, anchor="nw", fill="#4d6258", font=("Segoe UI", 8, "bold"))
            tk.Label(card, text=name, bg="#ffffff", fg="#17211e", font=("Segoe UI", 10, "bold"), wraplength=190).pack(anchor="w")
            tk.Label(card, text=seller, bg="#ffffff", fg="#71807a", font=("Segoe UI", 9)).pack(anchor="w", pady=(3, 9))
            tk.Label(card, text=price, bg="#ffffff", fg="#b27d19", font=("Segoe UI", 12, "bold")).pack(side="left")
            ttk.Button(card, text="View", style="Secondary.TButton", command=lambda n=name: messagebox.showinfo("Product preview", f"{n}\n\nCheckout is ready to connect to your payment provider.")).pack(side="right")

    def _freelance(self):
        self._header("Services and software", "Freelance marketplace", "Hire a specialist, sell a packaged service, or request a custom project.")
        toolbar = ttk.Frame(self.main, style="App.TFrame")
        toolbar.pack(fill="x", pady=(0, 12))
        ttk.Button(toolbar, text="+ Sell a service", style="Primary.TButton", command=self._sell_service).pack(side="right")
        ttk.Button(toolbar, text="Request custom work", style="Secondary.TButton", command=self._custom_work).pack(side="right", padx=(0, 8))
        grid = ttk.Frame(self.main, style="App.TFrame")
        grid.pack(fill="both", expand=True)
        for i in range(2):
            grid.columnconfigure(i, weight=1)
        gigs = [
            ("I will edit your short-form videos", "Mina K. · 5.0", "$35", "VIDEO"),
            ("I will build a clean Shopify landing page", "Dev Studio · 4.9", "$120", "SOFTWARE"),
            ("I will write product descriptions that sell", "Words by Noor · 4.8", "$25", "WRITING"),
            ("I will automate your weekly reports", "Apex Labs · 5.0", "$85", "AUTOMATION"),
        ]
        for index, (title, seller, price, tag) in enumerate(gigs):
            card = ttk.Frame(grid, style="Card.TFrame", padding=18)
            card.grid(row=index // 2, column=index % 2, sticky="nsew", padx=6, pady=6)
            tk.Label(card, text=tag, bg="#d9e4dd", fg="#315d4b", padx=8, pady=4, font=("Segoe UI", 8, "bold")).pack(anchor="w")
            tk.Label(card, text=title, bg="#ffffff", fg="#17211e", font=("Segoe UI", 12, "bold"), wraplength=340, justify="left").pack(anchor="w", pady=(14, 4))
            tk.Label(card, text=seller, bg="#ffffff", fg="#71807a", font=("Segoe UI", 9)).pack(anchor="w")
            tk.Label(card, text=f"Starting at {price}", bg="#ffffff", fg="#b27d19", font=("Segoe UI", 11, "bold")).pack(anchor="w", pady=(14, 10))
            ttk.Button(card, text="View service", style="Secondary.TButton", command=lambda t=title: messagebox.showinfo("Service", f"{t}\n\nSecure checkout and milestone delivery are ready to connect to a payment provider.")).pack(anchor="w")

    def _transactions(self):
        self._header("Money movement", "Transaction tracking", "Every task, sale, and payout has a clear status and audit trail.")
        panel = ttk.Frame(self.main, style="Card.TFrame", padding=20)
        panel.pack(fill="both", expand=True)
        ttk.Label(panel, text="ALL ACTIVITY", style="H2.TLabel").pack(anchor="w", pady=(0, 16))
        for event, amount, date, status in self.transactions:
            row = ttk.Frame(panel, style="Card.TFrame")
            row.pack(fill="x", pady=9)
            tk.Label(row, text=event, bg="#ffffff", fg="#17211e", font=("Segoe UI", 10, "bold")).pack(side="left")
            tk.Label(row, text=status, bg="#dcece3", fg="#2c7854", padx=8, pady=4, font=("Segoe UI", 8, "bold")).pack(side="right")
            tk.Label(row, text=date, bg="#ffffff", fg="#71807a", font=("Segoe UI", 9)).pack(side="right", padx=18)
            tk.Label(row, text=amount, bg="#ffffff", fg="#2c7854" if amount.startswith("+") else "#a55c52", font=("Segoe UI", 10, "bold")).pack(side="right", padx=18)

    def _post_task(self):
        dialog = tk.Toplevel(self)
        dialog.title("Post a video task")
        dialog.geometry("430x360")
        dialog.configure(bg="#ffffff")
        dialog.transient(self)
        tk.Label(dialog, text="Post a video task", bg="#ffffff", fg="#17211e", font=("Segoe UI", 16, "bold")).pack(anchor="w", padx=24, pady=(24, 4))
        tk.Label(dialog, text="Clients define a link, required watch time, and payout per verified view.", bg="#ffffff", fg="#61706b", wraplength=360, justify="left", font=("Segoe UI", 9)).pack(anchor="w", padx=24, pady=(0, 16))
        fields = {}
        for label, key in (("Video link", "link"), ("Campaign title", "title"), ("Payout per view", "reward")):
            tk.Label(dialog, text=label, bg="#ffffff", fg="#61706b", font=("Segoe UI", 9, "bold")).pack(anchor="w", padx=24, pady=(6, 3))
            entry = ttk.Entry(dialog)
            entry.pack(fill="x", padx=24)
            fields[key] = entry
        def submit():
            title = fields["title"].get().strip() or "New client video campaign"
            self.tasks.insert(0, (title, "Your campaign", 60, fields["reward"].get().strip() or "$0.50"))
            dialog.destroy()
            messagebox.showinfo("Task posted", "Your campaign is queued for review and will appear in Watch & earn.")
        ttk.Button(dialog, text="Publish task", style="Primary.TButton", command=submit).pack(anchor="w", padx=24, pady=20)

    def _sell_service(self):
        messagebox.showinfo("Sell a service", "Service listing flow ready: define packages, delivery time, revisions, portfolio samples, and a secure milestone price.")

    def _custom_work(self):
        messagebox.showinfo("Request custom work", "Custom brief flow ready: describe your project, attach references, set a budget, and invite proposals.")

    def _wallet(self):
        self._header("Your money", "Wallet", "Track earnings from tasks and sales, then request a payout when you are ready.")
        card = ttk.Frame(self.main, style="Card.TFrame", padding=24)
        card.pack(fill="x")
        tk.Label(card, text="AVAILABLE TO PAY OUT", bg="#ffffff", fg="#71807a", font=("Segoe UI", 9, "bold")).pack(anchor="w")
        tk.Label(card, text=f"${self.balance:,.2f}", bg="#ffffff", fg="#17211e", font=("Segoe UI", 32, "bold")).pack(anchor="w", pady=(6, 2))
        ttk.Label(card, text="Next payout window: Wednesday", style="Body.TLabel").pack(anchor="w")
        ttk.Button(card, text="Request payout", style="Primary.TButton", command=self._payout).pack(anchor="w", pady=(18, 0))
        history = ttk.Frame(self.main, style="Card.TFrame", padding=20)
        history.pack(fill="both", expand=True, pady=(18, 0))
        ttk.Label(history, text="Recent activity", style="H2.TLabel").pack(anchor="w", pady=(0, 12))
        for event, amount, date in [("Task verified · Noma Home", "+$0.80", "Today"), ("Store sale · Linen market tote", "+$24.00", "Yesterday"), ("Payout to Visa •• 4281", "-$80.00", "Sep 17")]:
            row = ttk.Frame(history, style="Card.TFrame")
            row.pack(fill="x", pady=8)
            tk.Label(row, text=event, bg="#ffffff", fg="#17211e", font=("Segoe UI", 10)).pack(side="left")
            tk.Label(row, text=date, bg="#ffffff", fg="#71807a", font=("Segoe UI", 9)).pack(side="right", padx=20)
            tk.Label(row, text=amount, bg="#ffffff", fg="#2c7854" if amount.startswith("+") else "#a55c52", font=("Segoe UI", 10, "bold")).pack(side="right")

    def _profile(self):
        self._header("Account settings", "Your profile", "Keep your identity, payout details, and seller reputation in one place.")
        card = ttk.Frame(self.main, style="Card.TFrame", padding=22)
        card.pack(fill="x")
        tk.Label(card, text="AMINA RAHMAN", bg="#ffffff", fg="#17211e", font=("Segoe UI", 18, "bold")).pack(anchor="w")
        ttk.Label(card, text="amina@example.com  ·  Member since 2026", style="Body.TLabel").pack(anchor="w", pady=(4, 18))
        tk.Label(card, text="IDENTITY VERIFIED", bg="#ffffff", fg="#2c7854", font=("Segoe UI", 9, "bold")).pack(anchor="w")
        ttk.Label(card, text="Two-factor authentication is enabled", style="Body.TLabel").pack(anchor="w", pady=(4, 16))
        ttk.Button(card, text="Manage security", style="Secondary.TButton", command=lambda: messagebox.showinfo("Security", "Security settings are protected in this local prototype.")).pack(anchor="w")
        seller = ttk.Frame(self.main, style="Card.TFrame", padding=22)
        seller.pack(fill="x", pady=(18, 0))
        ttk.Label(seller, text="Seller profile", style="H2.TLabel").pack(anchor="w")
        ttk.Label(seller, text="Public storefront: Amina Designs  ·  4.9 rating  ·  12 sales", style="Body.TLabel").pack(anchor="w", pady=(6, 14))
        ttk.Button(seller, text="Edit storefront", style="Secondary.TButton", command=self._list_product).pack(anchor="w")

    def _list_product(self):
        messagebox.showinfo("List a product", "Seller listing flow ready: add photos, price, delivery details, and publish for review.")

    def _payout(self):
        if self.balance < 10:
            messagebox.showwarning("Minimum not reached", "You need at least $10.00 available before requesting a payout.")
            return
        messagebox.showinfo("Payout requested", f"Your ${self.balance:,.2f} payout request was queued for review.")


if __name__ == "__main__":
    TaskFlowApp().mainloop()
