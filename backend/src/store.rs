//! Stable storage: everything here survives upgrades.
//!
//! Nothing secret is ever stored. File contents, file names and heritage
//! contents arrive already encrypted by the browser. Accounts are only known
//! by their principal, which the browser derives from the account number the
//! user keeps; the account number itself never reaches this canister.

use candid::{CandidType, Decode, Deserialize, Encode, Principal};
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
use ic_stable_structures::storable::Bound;
use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap, StableCell, Storable};
use std::borrow::Cow;
use std::cell::RefCell;

pub type Mem = VirtualMemory<DefaultMemoryImpl>;

/// 1 XMR = 10^12 piconero.
#[allow(dead_code)]
pub const PICO: u64 = 1_000_000_000_000;

macro_rules! candid_storable {
    ($t:ty) => {
        impl Storable for $t {
            fn to_bytes(&self) -> Cow<'_, [u8]> {
                Cow::Owned(Encode!(self).expect("encode"))
            }
            fn into_bytes(self) -> Vec<u8> {
                Encode!(&self).expect("encode")
            }
            fn from_bytes(bytes: Cow<[u8]>) -> Self {
                Decode!(bytes.as_ref(), Self).expect("decode")
            }
            const BOUND: Bound = Bound::Unbounded;
        }
    };
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum Product {
    /// Vault tier 1, 2 or 3 (see `TIER_BYTES`).
    Vault(u8),
    Heritage,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct Config {
    /// "mainnet" or "stagenet". Decides the address prefix.
    pub network: String,
    /// Private VIEW key of the service wallet (can see incoming payments,
    /// cannot spend). `None` until set by a controller.
    pub view_key: Option<Vec<u8>>,
    /// Public SPEND key of the service wallet.
    pub spend_pub: Option<Vec<u8>>,
    /// Base URLs of HTTPS Monero nodes, e.g. "https://node.example:443".
    pub nodes: Vec<String>,
    pub min_confirmations: u32,
    /// Yearly prices in piconero: vault tiers 1..3, then heritage.
    pub vault_prices: Vec<u64>,
    pub heritage_price: u64,
    /// vetKD master key: "key_1" on mainnet, "dfx_test_key" locally.
    pub key_name: String,
    /// When true, no new orders are accepted (existing data unaffected).
    pub paused: bool,
    pub next_order: u64,
    pub next_file: u64,
    pub next_heritage: u64,
    /// Cached vetKD public key for heritage (context `HERITAGE_CONTEXT`).
    pub heritage_public_key: Option<Vec<u8>>,
    /// Lowered minimum switch interval (tests). `None` = 7 days.
    pub min_interval_sec: Option<u64>,
}
candid_storable!(Config);

impl Default for Config {
    fn default() -> Self {
        Config {
            network: "mainnet".into(),
            view_key: None,
            spend_pub: None,
            nodes: vec![],
            min_confirmations: 10,
            vault_prices: vec![30_000_000_000, 100_000_000_000, 350_000_000_000],
            heritage_price: 50_000_000_000,
            key_name: "key_1".into(),
            paused: false,
            next_order: 1,
            next_file: 1,
            next_heritage: 1,
            heritage_public_key: None,
            min_interval_sec: None,
        }
    }
}

#[derive(CandidType, Deserialize, Clone, Debug, Default)]
pub struct Account {
    /// 0 = no vault plan, otherwise 1..3.
    pub vault_tier: u8,
    /// End of the paid vault period (ns since epoch). 0 if never paid.
    pub vault_until: u64,
    /// End of the paid heritage period (ns). 0 if never paid.
    pub heritage_until: u64,
    /// Bytes counted against the vault quota (reserved at upload start).
    pub used: u64,
    pub created: u64,
}
candid_storable!(Account);

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum OrderStatus {
    Pending,
    Paid,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct Order {
    pub id: u64,
    pub owner: Principal,
    pub product: Product,
    pub years: u8,
    /// Amount due in piconero.
    pub amount: u64,
    /// Amount received so far (several transactions may add up).
    pub received: u64,
    /// Subaddress (account 0, minor = id) the payment must go to.
    pub address: String,
    pub created: u64,
    pub status: OrderStatus,
    pub txs: Vec<String>,
}
candid_storable!(Order);

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct FileMeta {
    /// Encrypted by the browser (name, type, file key wrapped with the account key).
    pub meta: Vec<u8>,
    /// Total ciphertext size announced at upload start (reserved in quota).
    pub size: u64,
    pub chunks: u32,
    pub received_chunks: u32,
    pub received_bytes: u64,
    pub complete: bool,
    pub created: u64,
}
candid_storable!(FileMeta);

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct Heir {
    /// SHA-256 of the heir's proof; the proof is SHA-256("ashkey-claim" || s)
    /// where s only exists in the heir's link.
    pub claim_hash: Vec<u8>,
    /// Content key, wrapped first with a key derived from s, then IBE-encrypted
    /// to this switch's vetKD identity.
    pub wrapped_key: Vec<u8>,
    pub opens: u32,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct Switch {
    pub id: u64,
    pub owner: Principal,
    /// Encrypted by the owner's browser with the account key (title, heir labels).
    pub meta: Vec<u8>,
    /// Random 32-byte IBE identity of this switch.
    pub ibe_id: Vec<u8>,
    pub size: u64,
    pub chunks: u32,
    pub received_chunks: u32,
    pub received_bytes: u64,
    pub complete: bool,
    pub created: u64,
    pub last_check_in: u64,
    pub interval_ns: u64,
    pub heirs: Vec<Heir>,
}
candid_storable!(Switch);

const MEM_CONFIG: MemoryId = MemoryId::new(0);
const MEM_ACCOUNTS: MemoryId = MemoryId::new(1);
const MEM_ORDERS: MemoryId = MemoryId::new(2);
const MEM_OWNER_ORDERS: MemoryId = MemoryId::new(3);
const MEM_USED_TX: MemoryId = MemoryId::new(4);
const MEM_FILES: MemoryId = MemoryId::new(5);
const MEM_CHUNKS: MemoryId = MemoryId::new(6);
const MEM_SWITCHES: MemoryId = MemoryId::new(7);
const MEM_OWNER_SWITCHES: MemoryId = MemoryId::new(8);
const MEM_SWITCH_CHUNKS: MemoryId = MemoryId::new(9);

thread_local! {
    static MM: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    pub static CONFIG: RefCell<StableCell<Config, Mem>> = RefCell::new(
        StableCell::init(MM.with(|m| m.borrow().get(MEM_CONFIG)), Config::default()));

    pub static ACCOUNTS: RefCell<StableBTreeMap<Principal, Account, Mem>> = RefCell::new(
        StableBTreeMap::init(MM.with(|m| m.borrow().get(MEM_ACCOUNTS))));

    pub static ORDERS: RefCell<StableBTreeMap<u64, Order, Mem>> = RefCell::new(
        StableBTreeMap::init(MM.with(|m| m.borrow().get(MEM_ORDERS))));

    /// (owner, order id) → ()
    pub static OWNER_ORDERS: RefCell<StableBTreeMap<(Principal, u64), (), Mem>> = RefCell::new(
        StableBTreeMap::init(MM.with(|m| m.borrow().get(MEM_OWNER_ORDERS))));

    /// Monero txid (hex) → order id. A transaction can only ever be credited once.
    pub static USED_TX: RefCell<StableBTreeMap<String, u64, Mem>> = RefCell::new(
        StableBTreeMap::init(MM.with(|m| m.borrow().get(MEM_USED_TX))));

    /// (owner, file id) → metadata
    pub static FILES: RefCell<StableBTreeMap<(Principal, u64), FileMeta, Mem>> = RefCell::new(
        StableBTreeMap::init(MM.with(|m| m.borrow().get(MEM_FILES))));

    /// (owner, file id, chunk index) → encrypted bytes
    pub static CHUNKS: RefCell<StableBTreeMap<(Principal, u64, u32), Vec<u8>, Mem>> = RefCell::new(
        StableBTreeMap::init(MM.with(|m| m.borrow().get(MEM_CHUNKS))));

    pub static SWITCHES: RefCell<StableBTreeMap<u64, Switch, Mem>> = RefCell::new(
        StableBTreeMap::init(MM.with(|m| m.borrow().get(MEM_SWITCHES))));

    /// (owner, switch id) → ()
    pub static OWNER_SWITCHES: RefCell<StableBTreeMap<(Principal, u64), (), Mem>> = RefCell::new(
        StableBTreeMap::init(MM.with(|m| m.borrow().get(MEM_OWNER_SWITCHES))));

    /// (switch id, chunk index) → encrypted bytes
    pub static SWITCH_CHUNKS: RefCell<StableBTreeMap<(u64, u32), Vec<u8>, Mem>> = RefCell::new(
        StableBTreeMap::init(MM.with(|m| m.borrow().get(MEM_SWITCH_CHUNKS))));
}

pub fn config() -> Config {
    CONFIG.with(|c| c.borrow().get().clone())
}

pub fn update_config(f: impl FnOnce(&mut Config)) {
    CONFIG.with(|c| {
        let mut cfg = c.borrow().get().clone();
        f(&mut cfg);
        c.borrow_mut().set(cfg);
    });
}

pub fn account(p: &Principal) -> Option<Account> {
    ACCOUNTS.with(|a| a.borrow().get(p))
}

pub fn put_account(p: Principal, acc: Account) {
    ACCOUNTS.with(|a| a.borrow_mut().insert(p, acc));
}
