import os
import json
import logging
import hashlib
import numpy as np
import pickle
from datetime import datetime
from typing import List, Dict, Optional, Any, Union, Tuple
import time
import traceback

import requests
import uvicorn
from fastapi import FastAPI, HTTPException, Depends, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from tqdm import tqdm
import torch
from sentence_transformers import SentenceTransformer, CrossEncoder
import chromadb
from chromadb.utils import embedding_functions
from rank_bm25 import BM25Okapi
import nltk
from nltk.tokenize import word_tokenize
from nltk.corpus import stopwords

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("RAGZ")

# Load environment variables from data directory
data_env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', '.env')
if os.path.exists(data_env_path):
    load_dotenv(dotenv_path=data_env_path, verbose=True)
    logger.info(f"Loaded environment variables from {data_env_path}")
else:
    # Fallback to local .env file if none exists in data folder
    local_env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if os.path.exists(local_env_path):
        load_dotenv(dotenv_path=local_env_path, verbose=True)
        logger.info(f"Loaded environment variables from {local_env_path}")
    else:
        logger.warning("No .env file found in data directory or locally")

# Debug: Print loaded environment variables for troubleshooting
logger.info(f"Loaded PAPERLESS_URL: {os.getenv('PAPERLESS_URL')}")
logger.info(f"Loaded PAPERLESS_NGX_URL: {os.getenv('PAPERLESS_NGX_URL')}")
logger.info(f"Loaded PAPERLESS_HOST: {os.getenv('PAPERLESS_HOST')}")
logger.info(f"Loaded PAPERLESS_API_TOKEN: {'[SET]' if os.getenv('PAPERLESS_API_TOKEN') else '[NOT SET]'}")

# Constants
DOCUMENTS_FILE = "./data/documents.json"
CHROMADB_DIR = "./data/chromadb"
BM25_FILE = "./data/bm25_index.pkl"
STATE_FILE = "./data/system_state.json"
EMBEDDING_MODEL_NAME = "paraphrase-multilingual-MiniLM-L12-v2"
CROSS_ENCODER_MODEL_NAME = "cross-encoder/ms-marco-MiniLM-L-6-v2"
COLLECTION_NAME = "documents"
BM25_WEIGHT = 0.3
SEMANTIC_WEIGHT = 0.7
MAX_RESULTS = 20

# Download NLTK resources if not present
nltk.download('punkt', quiet=True)
nltk.download('punkt_tab', quiet=True)
nltk.download('stopwords', quiet=True)

# Status und Konfiguration
class IndexingStatus(BaseModel):
    running: bool = False
    last_indexed: Optional[str] = None
    documents_count: int = 0
    up_to_date: bool = False
    message: str = ""

class SystemStatus(BaseModel):
    server_up: bool = True
    data_loaded: bool = False
    index_ready: bool = False
    chroma_ready: bool = False
    bm25_ready: bool = False
    indexing_status: IndexingStatus = IndexingStatus()

# Request models
class SearchRequest(BaseModel):
    query: str
    from_date: Optional[str] = None
    to_date: Optional[str] = None
    correspondent: Optional[str] = None

class IndexingRequest(BaseModel):
    force: bool = False
    background: bool = True

class AskQuestionRequest(BaseModel):
    question: str
    max_sources: int = 5

# Response models
class SearchResult(BaseModel):
    title: str
    correspondent: str
    date: str
    score: float
    cross_score: float
    snippet: str
    doc_id: Optional[int] = None

# Global state object
class GlobalState:
    def __init__(self):
        self.data_manager = None
        self.search_engine = None
        self.system_status = SystemStatus()
        self.indexing_status = IndexingStatus()
        self.state_schema_version = 1  # Track schema version for future upgrades
        self._indexed_document_ids = set()  # Store temporarily until data_manager is initialized
    
    def save_state(self):
        """Save global state to disk with schema version"""
        try:
            # Ensure data directory exists
            os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
            
            # Create a serializable state object
            state_dict = {
                "schema_version": self.state_schema_version,
                "indexing_status": {
                    "running": self.indexing_status.running,
                    "last_indexed": self.indexing_status.last_indexed,
                    "documents_count": self.indexing_status.documents_count,
                    "up_to_date": self.indexing_status.up_to_date,
                    "message": self.indexing_status.message
                },
                "system_status": {
                    "data_loaded": self.system_status.data_loaded,
                    "index_ready": self.system_status.index_ready,
                    "chroma_ready": self.system_status.chroma_ready,
                    "bm25_ready": self.system_status.bm25_ready
                },
                "indexed_document_ids": list(self.data_manager.indexed_document_ids) if self.data_manager else list(self._indexed_document_ids)
            }
            
            with open(STATE_FILE, 'w', encoding='utf-8') as f:
                json.dump(state_dict, f, ensure_ascii=False, indent=2)
                
            logger.info(f"System state saved to {STATE_FILE}")
            return True
        except Exception as e:
            logger.error(f"Error saving system state: {str(e)}")
            return False
    
    def load_state(self):
        """Load global state from disk with schema version check"""
        try:
            if os.path.exists(STATE_FILE):
                with open(STATE_FILE, 'r', encoding='utf-8') as f:
                    state_dict = json.load(f)
                
                # Check schema version for compatibility
                schema_version = state_dict.get("schema_version", 0)
                if schema_version != self.state_schema_version:
                    logger.warning(f"State file schema version mismatch: {schema_version} vs {self.state_schema_version}")
                    # Still try to load what we can
                
                # Update indexing status - ENSURE ALL FIELDS ARE PROPERLY UPDATED
                if "indexing_status" in state_dict:
                    idx_status = state_dict["indexing_status"]
                    self.indexing_status.last_indexed = idx_status.get("last_indexed")
                    self.indexing_status.documents_count = idx_status.get("documents_count", 0)
                    self.indexing_status.up_to_date = idx_status.get("up_to_date", False)
                    self.indexing_status.message = idx_status.get("message", "")
                    # Always set running to False on startup
                    self.indexing_status.running = False
                    
                    logger.info(f"Loaded indexing status: {self.indexing_status.documents_count} documents, last indexed: {self.indexing_status.last_indexed}")
                
                # Update system status
                if "system_status" in state_dict:
                    sys_status = state_dict["system_status"]
                    self.system_status.data_loaded = sys_status.get("data_loaded", False)
                    self.system_status.index_ready = sys_status.get("index_ready", False)
                    self.system_status.chroma_ready = sys_status.get("chroma_ready", False)
                    self.system_status.bm25_ready = sys_status.get("bm25_ready", False)
                
                # Store indexed_document_ids for later use when data_manager is initialized
                self._indexed_document_ids = set(state_dict.get("indexed_document_ids", []))
                
                logger.info(f"System state loaded from {STATE_FILE} with {len(self._indexed_document_ids)} indexed document IDs")
                return True
            else:
                logger.info("No system state file found, starting with default state")
                return False
        except Exception as e:
            logger.error(f"Error loading system state: {str(e)}")
            return False

global_state = GlobalState()

# Data Manager
class DataManager:
    def __init__(self, initialize_on_start=False):
        # Flexible Variablennamen für die API-Einstellungen - erweitert um PAPERLESS_API_URL
        paperless_api_url = os.getenv("PAPERLESS_API_URL") or os.getenv("PAPERLESS_URL") or os.getenv("PAPERLESS_NGX_URL") or os.getenv("PAPERLESS_HOST")
        
        # Entfernen des /api Suffix falls vorhanden
        if paperless_api_url and paperless_api_url.endswith('/api'):
            paperless_api_url = paperless_api_url[:-4]  # Entfernen der letzten 4 Zeichen (/api)
            logger.info(f"Removed '/api' suffix from URL: {paperless_api_url}")
        
        self.paperless_url = paperless_api_url
        self.paperless_token = os.getenv("PAPERLESS_TOKEN") or os.getenv("PAPERLESS_API_TOKEN") or os.getenv("PAPERLESS_APIKEY")
        
        # Debug-Informationen ausgeben
        logger.info(f"Environment variables: PAPERLESS_API_URL={os.getenv('PAPERLESS_API_URL')}, PAPERLESS_URL={os.getenv('PAPERLESS_URL')}, PAPERLESS_NGX_URL={os.getenv('PAPERLESS_NGX_URL')}, PAPERLESS_HOST={os.getenv('PAPERLESS_HOST')}")
        logger.info(f"Environment variables: PAPERLESS_TOKEN={'[SET]' if os.getenv('PAPERLESS_TOKEN') else '[NOT SET]'}, PAPERLESS_API_TOKEN={'[SET]' if os.getenv('PAPERLESS_API_TOKEN') else '[NOT SET]'}, PAPERLESS_APIKEY={'[SET]' if os.getenv('PAPERLESS_APIKEY') else '[NOT SET]'}")
        
        if not self.paperless_url or not self.paperless_token:
            logger.error("Missing PAPERLESS_API_URL/PAPERLESS_URL or PAPERLESS_API_TOKEN in .env file")
            raise ValueError("Missing Paperless API configuration in .env file")
        
        self.documents = []
        self.document_hashes = {}
        self.last_sync = None
        self.collection = None
        self.is_initialized = False
        self.chroma_initialized = False
        
        # Modelle nur initialisieren, wenn sie benötigt werden
        self.sentence_transformer = None
        self.embedding_function = None
        self.cross_encoder = None
        self.chroma_client = None
        
        # Add tracking for indexed documents
        self.indexed_document_ids = global_state._indexed_document_ids if global_state._indexed_document_ids else set()
        self.new_document_ids = set()  # Track IDs of newly discovered documents
        
        # Wenn True, initialisiere beim Start
        if initialize_on_start:
            self.initialize_models()
    
    def initialize_models(self):
        """Initialisiere NLP-Modelle und ChromaDB"""
        try:
            if self.sentence_transformer is None:
                logger.info("Initializing sentence transformer model")
                self.sentence_transformer = SentenceTransformer(EMBEDDING_MODEL_NAME)
                
            if self.embedding_function is None:
                logger.info("Initializing embedding function")
                self.embedding_function = embedding_functions.SentenceTransformerEmbeddingFunction(
                    model_name=EMBEDDING_MODEL_NAME
                )
                
            if self.cross_encoder is None:
                logger.info("Initializing cross-encoder model")
                self.cross_encoder = CrossEncoder(CROSS_ENCODER_MODEL_NAME)
                
            if self.chroma_client is None:
                logger.info("Initializing ChromaDB client")
                self.chroma_client = chromadb.PersistentClient(path=CHROMADB_DIR)
                
            self.is_initialized = True
            # Update state
            global_state.save_state()
            return True
        except Exception as e:
            logger.error(f"Error initializing models: {str(e)}")
            self.is_initialized = False
            return False
    
    def _get_headers(self):
        return {"Authorization": f"Token {self.paperless_token}"}
    
    def _compute_document_hash(self, doc):
        """Compute a hash for a document to track changes"""
        content = f"{doc['title']}{doc['content']}{doc['correspondent']}"
        return hashlib.sha256(content.encode()).hexdigest()
    
    def check_for_updates(self) -> Tuple[bool, str]:
        """Überprüft, ob neue Dokumente vorhanden sind, ohne sie herunterzuladen"""
        logger.info("Checking for document updates")
        
        try:
            # Prüfe nur die ersten Seite der API, um zu sehen, ob es Änderungen gibt
            url = f"{self.paperless_url}/api/documents/?page=1&page_size=10"
            response = requests.get(
                url,
                headers=self._get_headers(),
                timeout=10
            )
            
            if response.status_code != 200:
                return False, f"API error: {response.status_code}"
                
            # Nur die letzte Änderungszeit des neuesten Dokuments prüfen
            data = response.json()
            results = data.get("results", [])
            
            if not results:
                return False, "No documents found in API"
                
            newest_doc = results[0]  # API sortiert nach neuestem Dokument
            newest_id = newest_doc.get("id")
            
            # Check if newest document is already indexed
            if newest_id in self.indexed_document_ids:
                return False, "No new documents detected"
            else:
                return True, "New documents detected"
        except Exception as e:
            logger.error(f"Error checking for updates: {str(e)}")
            return False, f"Error: {str(e)}"
    
    def fetch_documents_from_api(self):
        """Fetch all documents from Paperless-NGX API with pagination"""
        logger.info(f"Fetching documents from Paperless-NGX API: {self.paperless_url}")
        
        documents = []
        page = 1
        has_next = True
        
        while has_next:
            logger.info(f"Fetching page {page}")
            try:
                url = f"{self.paperless_url}/api/documents/?page={page}&page_size=100"
                logger.info(f"Making request to: {url}")
                
                response = requests.get(
                    url,
                    headers=self._get_headers(),
                    timeout=30
                )
                
                # Log response information for debugging
                logger.info(f"Response status code: {response.status_code}")
                
                if response.status_code != 200:
                    logger.error(f"Failed to fetch documents: {response.status_code} - {response.text}")
                    raise Exception(f"API error: {response.status_code} - {response.text}")
                
                # Check if response is empty
                if not response.text:
                    logger.error("API returned empty response")
                    raise Exception("API returned empty response")
                
                try:
                    data = response.json()
                except requests.exceptions.JSONDecodeError as e:
                    logger.error(f"JSON decode error: {str(e)}")
                    logger.error(f"Response content: {response.text}")
                    raise Exception(f"Could not parse API response as JSON: {str(e)}")
                
                results = data.get("results", [])
                documents.extend(results)
                
                # Check if there's a next page
                if data.get("next"):
                    page += 1
                else:
                    has_next = False
                    
            except requests.exceptions.RequestException as e:
                logger.error(f"Request error: {str(e)}")
                raise Exception(f"API request failed: {str(e)}")
        
        # Process documents to extract required fields
        processed_docs = []
        for doc in tqdm(documents, desc="Processing documents"):
            # Fetch document content if not included in listing
            if "content" not in doc or not doc["content"]:
                content_response = requests.get(
                    f"{self.paperless_url}/api/documents/{doc['id']}/download/txt/",
                    headers=self._get_headers(),
                    timeout=30
                )
                
                if content_response.status_code == 200:
                    content = content_response.text
                else:
                    logger.warning(f"Could not fetch content for document {doc['id']}")
                    content = ""
            else:
                content = doc.get("content", "")
            
            # Get correspondent name
            correspondent = ""
            if doc.get("correspondent"):
                corr_id = doc["correspondent"]
                corr_response = requests.get(
                    f"{self.paperless_url}/api/correspondents/{corr_id}/",
                    headers=self._get_headers(),
                    timeout=10
                )
                
                if corr_response.status_code == 200:
                    correspondent = corr_response.json().get("name", "")
            
            # Get tag names
            tags = []
            if doc.get("tags"):
                for tag_id in doc["tags"]:
                    tag_response = requests.get(
                        f"{self.paperless_url}/api/tags/{tag_id}/",
                        headers=self._get_headers(),
                        timeout=10
                    )
                    
                    if tag_response.status_code == 200:
                        tags.append(tag_response.json().get("name", ""))
            
            # Create processed document
            processed_doc = {
                "id": doc.get("id"),
                "title": doc.get("title", ""),
                "content": content,
                "correspondent": correspondent,
                "created": doc.get("created_date", doc.get("created", "")),
                "tags": tags,
                "last_updated": doc.get("modified", "")
            }
            
            # Compute document hash
            processed_doc["hash"] = self._compute_document_hash(processed_doc)
            processed_docs.append(processed_doc)
        
        return processed_docs
    
    def _check_for_new_documents(self):
        """Check for new documents that haven't been indexed yet"""
        logger.info("Checking for new documents")
        
        try:
            # Fetch all documents from API
            api_documents = self.fetch_documents_from_api()
            
            # Find documents that aren't in our indexed set
            new_docs = []
            self.new_document_ids.clear()
            
            for doc in api_documents:
                if doc["id"] not in self.indexed_document_ids:
                    new_docs.append(doc)
                    self.new_document_ids.add(doc["id"])
                    self.indexed_document_ids.add(doc["id"])
            
            logger.info(f"Found {len(new_docs)} new documents to index")
            return new_docs
            
        except Exception as e:
            logger.error(f"Error checking for new documents: {str(e)}")
            return []
    
    def load_documents(self, force_refresh=False, check_new=False):
        """Load documents from file or API with option to check for new documents"""
        if os.path.exists(DOCUMENTS_FILE) and not force_refresh:
            logger.info(f"Loading documents from {DOCUMENTS_FILE}")
            try:
                with open(DOCUMENTS_FILE, 'r', encoding='utf-8') as f:
                    local_documents = json.load(f)
                
                # Validate loaded documents structure
                if not isinstance(local_documents, list) or (local_documents and not isinstance(local_documents[0], dict)):
                    logger.error("Invalid document structure in documents.json")
                    return []
                
                # If no indexed_document_ids loaded from state, populate from existing documents
                if not self.indexed_document_ids:
                    self.indexed_document_ids = {doc["id"] for doc in local_documents if "id" in doc}
                    logger.info(f"Initialized indexed_document_ids with {len(self.indexed_document_ids)} document IDs")
                
                self.last_sync = datetime.now().isoformat()
                self.documents = local_documents
                
                # Only check for new documents if explicitly requested
                if check_new:
                    logger.info("Explicitly checking for new documents")
                    new_docs = self._check_for_new_documents()
                    if new_docs:
                        logger.info(f"Found {len(new_docs)} new documents")
                        # Add new documents to our collection
                        self.documents.extend(new_docs)
                        self.save_documents()
                    else:
                        logger.info("No new documents found")
                else:
                    logger.info("Skipping check for new documents")
                    # Clear new_document_ids since we're not checking
                    self.new_document_ids = set()
                
                global_state.system_status.data_loaded = True
                global_state.indexing_status.documents_count = len(self.documents)
                global_state.indexing_status.last_indexed = self.last_sync
                
                # Save state after updating
                global_state.save_state()
                
                return self.documents
            except Exception as e:
                logger.error(f"Error loading documents: {str(e)}")
                logger.error(traceback.format_exc())
                return []
        else:
            if force_refresh:
                logger.info("Forcing full refresh from API")
                # Always do a full refresh if explicitly requested
                self.documents = self.fetch_documents_from_api()
                self.indexed_document_ids = {doc["id"] for doc in self.documents}
                self.new_document_ids = self.indexed_document_ids.copy()  # All docs are "new" in a full refresh
                self.save_documents()
                
                global_state.system_status.data_loaded = True
                global_state.indexing_status.documents_count = len(self.documents)
                global_state.indexing_status.last_indexed = datetime.now().isoformat()
                
                # Save state after updating
                global_state.save_state()
                
                return self.documents
            else:
                logger.info("No local documents found, fetching from API")
                self.documents = self.fetch_documents_from_api()
                self.indexed_document_ids = {doc["id"] for doc in self.documents}
                self.new_document_ids = self.indexed_document_ids.copy()  # All docs are "new" on first run
                self.save_documents()
                
                global_state.system_status.data_loaded = True
                global_state.indexing_status.documents_count = len(self.documents)
                global_state.indexing_status.last_indexed = datetime.now().isoformat()
                
                # Save state after updating
                global_state.save_state()
                
                return self.documents
    
    def save_documents(self):
        """Save documents to file"""
        # Ensure directory exists
        os.makedirs(os.path.dirname(DOCUMENTS_FILE), exist_ok=True)
        
        with open(DOCUMENTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(self.documents, f, ensure_ascii=False, indent=2)
        logger.info(f"Saved {len(self.documents)} documents to {DOCUMENTS_FILE}")
    
    def setup_chroma_collection(self, force_update=False):
        """Set up ChromaDB collection with support for adding only new documents"""
        if not self.is_initialized:
            success = self.initialize_models()
            if not success:
                logger.error("Failed to initialize models for ChromaDB setup")
                return None
        
        # Ensure ChromaDB directory exists
        os.makedirs(CHROMADB_DIR, exist_ok=True)
            
        # Check if collection exists
        try:
            existing_collections = self.chroma_client.list_collections()
            collection_exists = any(c.name == COLLECTION_NAME for c in existing_collections)
            
            if collection_exists and not force_update:
                try:
                    collection = self.chroma_client.get_collection(
                        name=COLLECTION_NAME, 
                        embedding_function=self.embedding_function
                    )
                    logger.info(f"Loaded existing ChromaDB collection '{COLLECTION_NAME}'")
                    
                    # Check if collection is valid by fetching count
                    collection_count = collection.count()
                    logger.info(f"ChromaDB collection contains {collection_count} documents")
                    
                    # If collection is empty but we have documents, force recreate
                    if collection_count == 0 and self.documents and len(self.documents) > 0:
                        logger.warning("Empty ChromaDB collection found but documents exist. Forcing update.")
                        force_update = True
                        # Recreate the collection below in the "else" block
                    else:
                        # If we have new documents but aren't forcing an update,
                        # add only the new documents to the collection
                        if self.new_document_ids and not force_update:
                            logger.info(f"Adding {len(self.new_document_ids)} new documents to ChromaDB collection")
                            
                            # Get only the new documents to add
                            new_docs = []
                            for doc in self.documents:
                                if doc["id"] in self.new_document_ids:
                                    new_docs.append(doc)
                            
                            # Add only the new documents
                            if new_docs:
                                self._add_documents_to_chroma(collection, new_docs)
                        
                        self.collection = collection
                        self.chroma_initialized = True
                        global_state.system_status.chroma_ready = True
                        
                        # Save state after updating
                        global_state.save_state()
                        
                        return collection
                
                except Exception as inner_e:
                    logger.error(f"Error accessing ChromaDB collection: {str(inner_e)}")
                    logger.error(traceback.format_exc())
                    logger.warning("Will attempt to recreate the collection")
                    force_update = True
                    # Will fall through to the recreate logic below
            
            # If we're forcing an update or collection didn't exist or is corrupted
            if force_update and collection_exists:
                logger.info(f"Forcing update of ChromaDB collection '{COLLECTION_NAME}'")
                self.chroma_client.delete_collection(COLLECTION_NAME)
            
            logger.info(f"Creating new ChromaDB collection '{COLLECTION_NAME}'")
            collection = self.chroma_client.create_collection(
                name=COLLECTION_NAME,
                embedding_function=self.embedding_function
            )
            
            # Load documents if not already loaded
            if not self.documents:
                self.load_documents()
            
            # Add all documents to collection
            self._add_documents_to_chroma(collection, self.documents)
            
            self.collection = collection
            self.chroma_initialized = True
            global_state.system_status.chroma_ready = True
            
            # Save state after updating
            global_state.save_state()
            
            return collection
                
        except Exception as e:
            logger.error(f"Error setting up ChromaDB collection: {str(e)}")
            logger.error(traceback.format_exc())
            global_state.system_status.chroma_ready = False
            self.chroma_initialized = False
            
            # Save state after updating
            global_state.save_state()
            
            raise
    
    def _add_documents_to_chroma(self, collection, documents):
        """Add documents to ChromaDB collection"""
        # We process in batches to avoid memory issues
        batch_size = 100
        total_docs = len(documents)
        
        for i in range(0, total_docs, batch_size):
            batch = documents[i:i+batch_size]
            logger.info(f"Processing batch {i//batch_size + 1}/{(total_docs-1)//batch_size + 1} ({len(batch)} documents)")
            
            ids = [str(doc["id"]) for doc in batch]
            
            # Prepare texts for embedding
            texts = [
                f"{doc['title']} {doc['correspondent']} {doc['content']}"
                for doc in batch
            ]
            
            # Prepare metadata
            metadatas = [
                {
                    "title": doc["title"],
                    "correspondent": doc["correspondent"],
                    "created": doc["created"],
                    "tags": ", ".join(doc["tags"]),
                    "hash": doc["hash"]
                }
                for doc in batch
            ]
            
            # Add or update documents in collection
            collection.upsert(
                ids=ids,
                documents=texts,
                metadatas=metadatas
            )
        
        logger.info(f"Added/updated {total_docs} documents to ChromaDB collection")


# Search Engine
class SearchEngine:
    def __init__(self, data_manager, initialize_on_start=False):
        self.data_manager = data_manager
        self.collection = None
        self.documents = None
        self.bm25 = None
        self.tokenized_corpus = None
        self.is_initialized = False
        self.bm25_initialized = False
        
        # Wenn True, initialisiere beim Start
        if initialize_on_start and self.data_manager.is_initialized:
            self.initialize()
    
    def validate_state(self):
        """Validate the state of the search engine components"""
        logger.info("Validating search engine state")
        valid = True
        
        # Check documents
        if not self.documents or len(self.documents) == 0:
            logger.error("Documents not loaded or empty")
            valid = False
        
        # Check ChromaDB
        if not self.collection:
            logger.error("ChromaDB collection not initialized")
            valid = False
        else:
            try:
                # Check if collection is accessible
                collection_count = self.collection.count()
                if collection_count == 0:
                    logger.error("ChromaDB collection is empty")
                    valid = False
                else:
                    logger.info(f"ChromaDB collection contains {collection_count} documents")
            except Exception as e:
                logger.error(f"Error accessing ChromaDB collection: {str(e)}")
                valid = False
        
        # Check BM25
        if not self.bm25 or not self.tokenized_corpus or len(self.tokenized_corpus) == 0:
            logger.error("BM25 index not properly initialized")
            valid = False
        else:
            # Check if BM25 corpus matches document count
            if len(self.tokenized_corpus) != len(self.documents):
                logger.error(f"BM25 corpus size mismatch: {len(self.tokenized_corpus)} vs {len(self.documents)} documents")
                valid = False
            else:
                logger.info(f"BM25 index contains {len(self.tokenized_corpus)} documents")
        
        # Set states based on validation
        if valid:
            logger.info("Search engine validation successful")
            self.is_initialized = True
            self.bm25_initialized = self.bm25 is not None
            global_state.system_status.index_ready = True
            global_state.system_status.bm25_ready = self.bm25_initialized
        else:
            logger.warning("Search engine validation failed")
            
        return valid
    
    def initialize(self, force_update=False):
        """Initialize search engine with support for adding only new documents"""
        try:
            # Ensure we have documents
            if not self.data_manager.documents:
                self.documents = self.data_manager.load_documents()
            else:
                self.documents = self.data_manager.documents
            
            # Validate documents array
            if not self.documents or len(self.documents) == 0:
                logger.error("No documents loaded")
                return False
            
            # Set up ChromaDB collection - this now handles adding only new documents
            if not self.data_manager.chroma_initialized or force_update:
                self.collection = self.data_manager.setup_chroma_collection(force_update=force_update)
            else:
                self.collection = self.data_manager.collection
            
            # Check if we have new documents
            have_new_docs = bool(self.data_manager.new_document_ids)
            
            # First try to load the BM25 index from disk if we don't need to rebuild
            bm25_loaded = False
            if os.path.exists(BM25_FILE) and not force_update:
                try:
                    # Load BM25 and verify it
                    bm25_loaded = self._load_bm25()
                    
                    # Check if tokenized corpus size matches document count
                    if bm25_loaded and self.tokenized_corpus and len(self.tokenized_corpus) != len(self.documents):
                        logger.warning(f"BM25 corpus size mismatch: {len(self.tokenized_corpus)} vs {len(self.documents)} documents")
                        logger.info("Forcing BM25 rebuild due to size mismatch")
                        bm25_loaded = False
                        self._setup_bm25()
                    elif bm25_loaded and have_new_docs:
                        # If we loaded BM25 successfully and have new documents, update BM25
                        logger.info("Updating BM25 with new documents")
                        self._add_new_documents_to_bm25()
                except Exception as e:
                    logger.error(f"Error loading BM25 index: {str(e)}")
                    logger.error(traceback.format_exc())
                    bm25_loaded = False
            
            # If BM25 wasn't loaded successfully, set up from scratch
            if not bm25_loaded:
                logger.info("Setting up BM25 from scratch")
                self._setup_bm25()
            
            # Validate the search engine state
            valid = self.validate_state()
            
            if valid:
                self.is_initialized = True
                global_state.system_status.index_ready = True
                # Save state after initializing
                global_state.save_state()
                logger.info("Search engine initialized successfully")
                return True
            else:
                logger.error("Search engine initialization failed validation")
                return False
                
        except Exception as e:
            logger.error(f"Error initializing search engine: {str(e)}")
            logger.error(traceback.format_exc())
            self.is_initialized = False
            global_state.system_status.index_ready = False
            global_state.save_state()
            return False
    
    def _setup_bm25(self):
        """Set up BM25 index"""
        logger.info("Initializing BM25 index")
        
        # Make sure we have documents
        if not self.documents or len(self.documents) == 0:
            logger.error("Cannot set up BM25 with empty documents list")
            self.bm25_initialized = False
            global_state.system_status.bm25_ready = False
            return False
        
        # Prepare corpus for BM25
        self.tokenized_corpus = []
        
        # Get stopwords for multiple languages
        stop_words = set()
        for lang in ['english', 'german', 'french', 'spanish', 'italian']:
            try:
                stop_words.update(stopwords.words(lang))
            except:
                pass
        
        # Tokenize documents
        for doc in tqdm(self.documents, desc="Tokenizing documents for BM25"):
            # Combine title, correspondent and content for search
            text = f"{doc['title']} {doc['correspondent']} {doc['content']}"
            
            # Tokenize and filter stopwords
            tokens = word_tokenize(text.lower())
            filtered_tokens = [token for token in tokens if token not in stop_words]
            
            self.tokenized_corpus.append(filtered_tokens)
        
        # Create BM25 index
        self.bm25 = BM25Okapi(self.tokenized_corpus)
        self.bm25_initialized = True
        global_state.system_status.bm25_ready = True
        
        # Save BM25 index to disk
        self._save_bm25()
        
        logger.info("BM25 index initialized and saved to disk")
        return True
    
    def _save_bm25(self):
        """Save BM25 index to disk"""
        # Ensure directory exists
        os.makedirs(os.path.dirname(BM25_FILE), exist_ok=True)
        
        try:
            # Save both the BM25 object and the tokenized corpus
            with open(BM25_FILE, 'wb') as f:
                pickle.dump({
                    'bm25': self.bm25,
                    'tokenized_corpus': self.tokenized_corpus
                }, f)
            logger.info(f"Saved BM25 index to {BM25_FILE}")
            return True
        except Exception as e:
            logger.error(f"Error saving BM25 index: {str(e)}")
            return False
    
    def _load_bm25(self):
        """Load BM25 index from disk"""
        logger.info(f"Loading BM25 index from {BM25_FILE}")
        try:
            with open(BM25_FILE, 'rb') as f:
                data = pickle.load(f)
            
            self.bm25 = data['bm25']
            self.tokenized_corpus = data['tokenized_corpus']
            
            # Validate BM25 index
            if not self.bm25 or not self.tokenized_corpus or len(self.tokenized_corpus) == 0:
                logger.error("Loaded BM25 index is invalid or empty")
                self.bm25_initialized = False
                global_state.system_status.bm25_ready = False
                return False
            
            # Check if tokenized corpus matches our document count
            if len(self.tokenized_corpus) != len(self.documents):
                logger.warning(f"BM25 corpus size mismatch: {len(self.tokenized_corpus)} vs {len(self.documents)} documents")
                # Don't fail here, the calling method will handle this
            
            self.bm25_initialized = True
            global_state.system_status.bm25_ready = True
            
            logger.info("BM25 index loaded successfully")
            return True
        except Exception as e:
            logger.error(f"Error loading BM25 index: {str(e)}")
            logger.error(traceback.format_exc())
            self.bm25_initialized = False
            global_state.system_status.bm25_ready = False
            return False
    
    def _add_new_documents_to_bm25(self):
        """Add only new documents to the BM25 index"""
        try:
            logger.info(f"Adding {len(self.data_manager.new_document_ids)} new documents to BM25 index")
            
            # If we don't have a tokenized corpus yet, we can't add to it
            if not hasattr(self, 'tokenized_corpus') or not self.tokenized_corpus:
                logger.error("No existing tokenized corpus for BM25 update")
                self._setup_bm25()  # Rebuild from scratch
                return
            
            # Get stopwords for multiple languages
            stop_words = set()
            for lang in ['english', 'german', 'french', 'spanish', 'italian']:
                try:
                    stop_words.update(stopwords.words(lang))
                except:
                    pass
            
            # Create a map for quick document lookup by ID
            documents_by_id = {doc["id"]: doc for doc in self.documents}
            
            # Process each new document
            new_docs_processed = 0
            for doc_id in self.data_manager.new_document_ids:
                if doc_id in documents_by_id:
                    doc = documents_by_id[doc_id]
                    
                    # Tokenize the document
                    text = f"{doc['title']} {doc['correspondent']} {doc['content']}"
                    tokens = word_tokenize(text.lower())
                    filtered_tokens = [token for token in tokens if token not in stop_words]
                    
                    # Add to the tokenized corpus
                    self.tokenized_corpus.append(filtered_tokens)
                    new_docs_processed += 1
            
            # Rebuild BM25 with the updated corpus
            if new_docs_processed > 0:
                self.bm25 = BM25Okapi(self.tokenized_corpus)
                self.bm25_initialized = True
                global_state.system_status.bm25_ready = True
                
                # Save the updated BM25 index
                self._save_bm25()
                
                logger.info(f"BM25 index updated with {new_docs_processed} new documents")
            else:
                logger.info("No new documents were processed for BM25")
                
        except Exception as e:
            logger.error(f"Error adding new documents to BM25: {str(e)}")
            logger.error(traceback.format_exc())
            # If anything goes wrong, rebuild from scratch
            self._setup_bm25()
    
    def keyword_search(self, query, top_k=MAX_RESULTS):
        """Perform keyword search using BM25"""
        if not self.is_initialized:
            logger.error("Search engine not initialized for keyword search")
            raise Exception("Search engine not initialized")
            
        if not self.bm25_initialized or not self.bm25 or not self.tokenized_corpus:
            logger.error("BM25 index not properly initialized")
            raise Exception("BM25 index not properly initialized")
            
        # Ensure documents match tokenized corpus
        if len(self.tokenized_corpus) != len(self.documents):
            logger.error(f"BM25 corpus size mismatch: {len(self.tokenized_corpus)} vs {len(self.documents)} documents")
            raise Exception("BM25 index does not match document count")
            
        # Tokenize query
        query_tokens = word_tokenize(query.lower())
        
        # Get BM25 scores
        scores = self.bm25.get_scores(query_tokens)
        
        # Check if scores is a valid array
        if not isinstance(scores, np.ndarray) or len(scores) != len(self.documents):
            logger.error(f"Invalid BM25 scores: {type(scores)}, length {len(scores) if hasattr(scores, '__len__') else 'unknown'}")
            raise Exception("BM25 returned invalid scores")
        
        # Get document indices sorted by score
        doc_scores = [(i, score) for i, score in enumerate(scores)]
        doc_scores.sort(key=lambda x: x[1], reverse=True)
        
        # Get top-k documents
        results = []
        for i, score in doc_scores[:top_k]:
            if score > 0:  # Only include documents with non-zero scores
                try:
                    doc = self.documents[i]
                    results.append({
                        "id": doc["id"],
                        "title": doc["title"],
                        "correspondent": doc["correspondent"],
                        "date": doc["created"],
                        "score": float(score),
                        "content": doc["content"]
                    })
                except IndexError as e:
                    logger.error(f"Document index out of range: {i} (max: {len(self.documents)-1})")
                except Exception as e:
                    logger.error(f"Error processing document at index {i}: {str(e)}")
        
        logger.info(f"Keyword search found {len(results)} results")
        return results
    
    def semantic_search(self, query, top_k=MAX_RESULTS):
        """Perform semantic search using ChromaDB"""
        if not self.is_initialized:
            logger.error("Search engine not initialized for semantic search")
            raise Exception("Search engine not initialized")
            
        if not self.collection:
            logger.error("ChromaDB collection not properly initialized")
            raise Exception("ChromaDB collection not properly initialized")
            
        try:
            results = self.collection.query(
                query_texts=[query],
                n_results=min(top_k, 100)  # Limit to avoid overloading
            )
            
            if not results or "ids" not in results or not results["ids"] or len(results["ids"]) == 0:
                logger.warning("ChromaDB search returned no results")
                return []
                
            # Check if results are valid
            if len(results["ids"][0]) == 0:
                logger.warning("ChromaDB search returned empty results list")
                return []
            
            documents = []
            for i, doc_id in enumerate(results["ids"][0]):
                try:
                    # Find the document in our list
                    doc = next((d for d in self.documents if str(d["id"]) == doc_id), None)
                    
                    if doc:
                        distance = results["distances"][0][i] if "distances" in results and len(results["distances"]) > 0 else 1.0
                        documents.append({
                            "id": doc["id"],
                            "title": doc["title"],
                            "correspondent": doc["correspondent"],
                            "date": doc["created"],
                            "score": float(distance) if isinstance(distance, (int, float)) else 1.0,
                            "content": doc["content"]
                        })
                except Exception as e:
                    logger.error(f"Error processing document with ID {doc_id}: {str(e)}")
            
            logger.info(f"Semantic search found {len(documents)} results")
            return documents
            
        except Exception as e:
            logger.error(f"Error in semantic search: {str(e)}")
            logger.error(traceback.format_exc())
            return []
    
    def hybrid_search(self, query, top_k=MAX_RESULTS):
        """Perform hybrid search combining BM25 and semantic search"""
        logger.info(f"Performing hybrid search for query: '{query}'")
        
        if not self.is_initialized:
            logger.error("Search engine not initialized for hybrid search")
            self.initialize(force_update=False)  # Try to initialize if possible
            if not self.is_initialized:
                raise Exception("Search engine could not be initialized")
        
        # Ensure both search components are ready
        if not self.bm25_initialized:
            logger.error("BM25 not initialized for hybrid search")
            self._setup_bm25()  # Try to rebuild BM25
            if not self.bm25_initialized:
                # Fall back to just semantic search if BM25 fails
                logger.warning("Falling back to semantic search only")
                return self.semantic_search(query, top_k)
                
        if not self.collection:
            logger.error("ChromaDB collection not available for hybrid search")
            self.data_manager.setup_chroma_collection()  # Try to set up ChromaDB
            if not self.collection:
                # Fall back to just keyword search if semantic fails
                logger.warning("Falling back to keyword search only")
                return self.keyword_search(query, top_k)
            
        # Get results from both search methods
        try:
            keyword_results = self.keyword_search(query, top_k=top_k*2)
        except Exception as e:
            logger.error(f"Keyword search failed: {str(e)}")
            keyword_results = []
            
        try:
            semantic_results = self.semantic_search(query, top_k=top_k*2)
        except Exception as e:
            logger.error(f"Semantic search failed: {str(e)}")
            semantic_results = []
            
        # If both searches failed, return a proper error
        if not keyword_results and not semantic_results:
            logger.error("Both search methods failed")
            raise Exception("All search methods failed")
        
        # Combine results
        results_map = {}
        
        # Normalize scores
        if keyword_results:
            max_keyword_score = max((r["score"] for r in keyword_results), default=1.0)
            for r in keyword_results:
                r["score"] = r["score"] / max_keyword_score if max_keyword_score > 0 else 0
        
        if semantic_results:
            # For semantic search, lower distance is better, so invert the score
            for r in semantic_results:
                # Convert distance to similarity score (1 - normalized_distance)
                r["score"] = 1 - r["score"] if r["score"] <= 1 else 0
        
        # Add keyword results with weight
        for result in keyword_results:
            doc_id = result["id"]
            results_map[doc_id] = {
                **result,
                "score": result["score"] * BM25_WEIGHT
            }
        
        # Add semantic results with weight
        for result in semantic_results:
            doc_id = result["id"]
            if doc_id in results_map:
                results_map[doc_id]["score"] += result["score"] * SEMANTIC_WEIGHT
            else:
                results_map[doc_id] = {
                    **result,
                    "score": result["score"] * SEMANTIC_WEIGHT
                }
        
        # Convert map to list and sort by score
        combined_results = list(results_map.values())
        combined_results.sort(key=lambda x: x["score"], reverse=True)
        
        logger.info(f"Hybrid search found {len(combined_results)} results")
        return combined_results[:top_k]
    
    def rerank_results(self, query, results, top_k=MAX_RESULTS):
        """Rerank results using cross-encoder"""
        # More defensive check
        if not results or len(results) == 0:
            logger.warning("No results to rerank")
            return []
            
        try:
            # Prepare pairs for cross-encoder
            pairs = [(query, f"{result['title']} {result['content'][:500]}" if 'content' in result and result['content'] else result.get('title', '')) 
                    for result in results]
            
            # Make sure we have valid pairs
            if not pairs:
                logger.warning("No valid pairs to rerank")
                return results  # Return original results without reranking
                
            # Get cross-encoder scores
            cross_scores = self.data_manager.cross_encoder.predict(pairs)
            
            # Make sure we got valid scores
            if not isinstance(cross_scores, np.ndarray) or len(cross_scores) != len(results):
                logger.error(f"Invalid cross-encoder scores: got {len(cross_scores) if hasattr(cross_scores, '__len__') else 'invalid'} scores for {len(results)} results")
                for result in results:
                    result["cross_score"] = 0.5  # Default score
                return results  # Return original results with default scores
                
            # Add cross-encoder scores to results
            for i, score in enumerate(cross_scores):
                if i < len(results):  # Make sure we don't go out of bounds
                    # Convert score to a positive value by taking the sigmoid 
                    # This maps any score to a value between 0 and 1
                    # For cross-encoders, higher should be better matches
                    norm_score = 1.0 / (1.0 + np.exp(-score))
                    results[i]["cross_score"] = float(norm_score)
            
            # Fill in any missing scores
            for i in range(len(results)):
                if "cross_score" not in results[i]:
                    results[i]["cross_score"] = 0.5  # Default score
            
            # Sort by cross-encoder score
            results.sort(key=lambda x: x["cross_score"], reverse=True)
            
            logger.info(f"Reranked {len(results)} results")
            return results[:top_k]
            
        except Exception as e:
            logger.error(f"Error reranking results: {str(e)}")
            logger.error(traceback.format_exc())
            
            # Add default cross scores and return the original results
            for result in results:
                result["cross_score"] = 0.5  # Default score
            
            return results[:top_k]
    
    def create_snippet(self, query, content, max_len=200):
        """Create a relevant snippet from the document content"""
        if not content:
            return ""
        
        try:
            # Get query terms
            query_terms = set(word_tokenize(query.lower()))
            
            # Split content into sentences
            sentences = content.split(". ")
            
            # Score sentences by number of query terms
            sentence_scores = []
            for sentence in sentences:
                sentence_terms = set(word_tokenize(sentence.lower()))
                score = len(query_terms.intersection(sentence_terms))
                sentence_scores.append((sentence, score))
            
            # Sort sentences by score
            sentence_scores.sort(key=lambda x: x[1], reverse=True)
            
            # Create snippet from top sentences
            snippet = ""
            for sentence, _ in sentence_scores:
                if len(snippet) + len(sentence) <= max_len:
                    snippet += sentence + ". "
                else:
                    break
            
            # If snippet is empty (no term matches), just use the beginning of the content
            if not snippet and content:
                snippet = content[:max_len] + "..."
            
            return snippet.strip()
            
        except Exception as e:
            logger.error(f"Error creating snippet: {str(e)}")
            # Fallback to simple snippet creation
            if content:
                return content[:max_len] + "..."
            return ""
    
    def search(self, request: SearchRequest):
        """Perform full search with filters and reranking"""
        if not self.is_initialized:
            logger.error("Search engine not initialized")
            # Try to initialize before failing
            success = self.initialize(force_update=False)
            if not success:
                raise Exception("Search engine could not be initialized")
            
        query = request.query
        logger.info(f"Performing search for: '{query}'")
        
        try:
            # Perform hybrid search
            results = self.hybrid_search(query)
            
            # Check if we got valid results
            if not results:
                logger.warning("Hybrid search returned no results")
                return []
                
            # Apply filters
            if request.from_date or request.to_date or request.correspondent:
                filtered_results = []
                for result in results:
                    include = True
                    
                    # Filter by date range
                    if request.from_date and result["date"]:
                        try:
                            doc_date = result["date"].split("T")[0]  # Get date part only
                            if doc_date < request.from_date:
                                include = False
                        except:
                            pass
                    
                    if request.to_date and result["date"]:
                        try:
                            doc_date = result["date"].split("T")[0]  # Get date part only
                            if doc_date > request.to_date:
                                include = False
                        except:
                            pass
                    
                    # Filter by correspondent
                    if request.correspondent and result["correspondent"]:
                        if request.correspondent.lower() not in result["correspondent"].lower():
                            include = False
                    
                    if include:
                        filtered_results.append(result)
                
                results = filtered_results
            
            # Check if we still have results after filtering
            if not results:
                logger.warning("No results after applying filters")
                return []
                
            # Rerank results
            reranked_results = self.rerank_results(query, results)
            
            # Format results
            formatted_results = []
            for result in reranked_results:
                try:
                    snippet = self.create_snippet(query, result["content"])
                    
                    formatted_results.append(SearchResult(
                        title=result["title"] or "Untitled",
                        correspondent=result["correspondent"] or "",
                        date=result["date"] or "",
                        score=result["score"],
                        cross_score=result.get("cross_score", 0.5),
                        snippet=snippet,
                        doc_id=result["id"]
                    ))
                except Exception as item_e:
                    logger.error(f"Error formatting search result: {str(item_e)}")
            
            logger.info(f"Returning {len(formatted_results)} search results")
            return formatted_results
            
        except Exception as e:
            logger.error(f"Error in search: {str(e)}")
            logger.error(traceback.format_exc())
            raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")

# Indexierung als Hintergrundaufgabe
def run_indexing(force_update=False, check_new=False):
    """Führt die Indexierung als Hintergrundaufgabe aus mit Fokus auf neue Dokumente"""
    try:
        global_state.indexing_status.running = True
        global_state.indexing_status.message = "Indexierung gestartet"
        global_state.save_state()
        
        # Check if models are initialized
        if not global_state.data_manager.is_initialized:
            global_state.indexing_status.message = "Initializing models"
            global_state.save_state()
            global_state.data_manager.initialize_models()
        
        # Dokumente aktualisieren
        if force_update:
            global_state.indexing_status.message = "Vollständige Neuindexierung wird durchgeführt"
            global_state.save_state()
            # Force refresh will reindex everything
            global_state.data_manager.load_documents(force_refresh=True)
        else:
            # Check if we need to check for new documents
            should_check = global_state.system_status.data_loaded == False or check_new
            
            if should_check:
                global_state.indexing_status.message = "Prüfe auf neue Dokumente"
                global_state.save_state()
                # Explicitly check for new documents
                global_state.data_manager.load_documents(force_refresh=False, check_new=True)
            else:
                global_state.indexing_status.message = "Lade vorhandene Dokumente ohne Aktualisierung"
                global_state.save_state()
                # Load documents without checking for new ones
                global_state.data_manager.load_documents(force_refresh=False, check_new=False)
        
        # Determine if new documents were found
        new_docs_count = len(global_state.data_manager.new_document_ids)
        
        # Update the status message based on whether new documents were found
        if new_docs_count > 0:
            global_state.indexing_status.message = f"Indexiere {new_docs_count} neue Dokumente"
            global_state.save_state()
            
            # Initialize or update the search engine
            # The force_update parameter will be passed through to control whether
            # to do a full rebuild or just add new documents
            global_state.search_engine.initialize(force_update=force_update)
            
            global_state.indexing_status.message = f"Indexierung abgeschlossen - {new_docs_count} neue Dokumente hinzugefügt"
        else:
            # If we have documents loaded and search engine not initialized, load existing indexes
            if global_state.system_status.data_loaded and not global_state.search_engine.is_initialized:
                # Just load existing indexes without rebuilding
                global_state.indexing_status.message = "Lade vorhandene Indizes"
                global_state.save_state()
                global_state.search_engine.initialize(force_update=False)
            
            global_state.indexing_status.message = "Keine neuen Dokumente gefunden, Suchindex ist aktuell"
        
        # Validate the search engine after indexing
        if not global_state.search_engine.is_initialized or not global_state.search_engine.validate_state():
            logger.warning("Search engine validation failed after indexing, forcing rebuild")
            global_state.indexing_status.message = "Validation failed, rebuilding index"
            global_state.save_state()
            
            # Force rebuild of search engine
            global_state.search_engine.initialize(force_update=True)
            
            if global_state.search_engine.is_initialized:
                global_state.indexing_status.message = "Index rebuilt successfully"
            else:
                global_state.indexing_status.message = "Failed to rebuild index"
        
        # Status aktualisieren
        global_state.indexing_status.running = False
        global_state.indexing_status.last_indexed = datetime.now().isoformat()
        global_state.indexing_status.up_to_date = True
        global_state.save_state()
        
    except Exception as e:
        global_state.indexing_status.running = False
        global_state.indexing_status.message = f"Fehler bei der Indexierung: {str(e)}"
        global_state.save_state()
        logger.error(f"Indexing error: {str(e)}")
        logger.error(traceback.format_exc())

# FastAPI Application
app = FastAPI(title="RAGZ Document Search API")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict to your Node.js server
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Abhängigkeit zur Überprüfung, ob die Suchmaschine initialisiert ist
def get_search_engine():
    if not global_state.search_engine:
        logger.error("Search engine not initialized")
        raise HTTPException(
            status_code=503, 
            detail="Search engine not initialized. Please initialize the engine first."
        )
        
    # Validate the search engine state if it's marked as initialized
    if global_state.search_engine.is_initialized:
        # Quick validation of BM25 and collection
        if (not global_state.search_engine.bm25_initialized or 
            not global_state.search_engine.collection):
            logger.error("Search engine components are missing, trying to reinitialize")
            try:
                # Try to reinitialize without force update to preserve existing data
                global_state.search_engine.initialize(force_update=False)
            except Exception as e:
                logger.error(f"Failed to reinitialize search engine: {str(e)}")
                # Still try to force rebuild as last resort
                try:
                    global_state.search_engine.initialize(force_update=True)
                except Exception as e2:
                    logger.error(f"Forced reinitialization failed: {str(e2)}")
                    logger.error(traceback.format_exc())
                    raise HTTPException(
                        status_code=503, 
                        detail="Search engine is corrupted and could not be reinitialized."
                    )
        
    # If not initialized, initialize it
    if not global_state.search_engine.is_initialized:
        logger.warning("Search engine not initialized, attempting to initialize on demand")
        try:
            global_state.search_engine.initialize(force_update=False)
            if not global_state.search_engine.is_initialized:
                raise Exception("Initialization failed")
        except Exception as e:
            logger.error(f"Failed to initialize search engine: {str(e)}")
            raise HTTPException(
                status_code=503, 
                detail="Search engine initialization failed. Please try again."
            )
            
    return global_state.search_engine

@app.on_event("startup")
async def startup_event():
    """Enhanced startup - initialize global state and attempt to load existing data without reindexing"""
    global global_state
    
    logger.info("Starting RAGZ Document Search API")
    
    try:
        # Load saved system state if it exists
        global_state.load_state()
        
        # Verify loaded status values are consistent
        logger.info(f"Loaded state has documents_count: {global_state.indexing_status.documents_count}")
        
        # Überprüfen, ob .env-Datei existiert
        env_file_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', '.env')
        if not os.path.exists(env_file_path):
            logger.warning(f".env file not found at {os.path.abspath(env_file_path)}")
            logger.info("Creating example .env file")
            
            # Ensure directory exists
            os.makedirs(os.path.dirname(env_file_path), exist_ok=True)
            
            with open(env_file_path, "w") as f:
                f.write("# Paperless-NGX API configuration\n")
                f.write("PAPERLESS_URL=https://your-paperless-instance\n")
                f.write("PAPERLESS_API_TOKEN=your-api-token\n")
            logger.info(f"Created example .env file at {os.path.abspath(env_file_path)}")
            logger.info("Please edit the .env file with your Paperless-NGX API configuration")
            logger.warning("Starting with limited functionality due to missing API configuration")
            
            # Trotzdem fortfahren mit eingeschränkter Funktionalität
            global_state.system_status.server_up = True
            global_state.indexing_status.message = "API configuration missing in .env file"
            global_state.save_state()
            return
        
        # Initialize DataManager with model loading but WITHOUT document loading
        global_state.data_manager = DataManager(initialize_on_start=False)
        # Just initialize the models but don't load documents yet
        global_state.data_manager.initialize_models()
        
        # Check if documents exist and ChromaDB is ready
        documents_exist = os.path.exists(DOCUMENTS_FILE)
        chromadb_exists = os.path.exists(CHROMADB_DIR)
        chroma_collection_exists = False
        bm25_exists = os.path.exists(BM25_FILE)
        
        if chromadb_exists and global_state.data_manager.chroma_client:
            existing_collections = global_state.data_manager.chroma_client.list_collections()
            chroma_collection_exists = any(c.name == COLLECTION_NAME for c in existing_collections)
        
        # If both documents and chroma collection exist, we can auto-load WITHOUT reindexing
        if documents_exist:
            logger.info("Found existing data, loading without reindexing")
            
            # Just load the documents from the file (no API calls, no reindexing)
            if not global_state.system_status.data_loaded:
                try:
                    # Load documents without checking for new ones
                    global_state.data_manager.documents = []
                    with open(DOCUMENTS_FILE, 'r', encoding='utf-8') as f:
                        loaded_docs = json.load(f)
                        
                        # Validate document structure
                        if not isinstance(loaded_docs, list) or (loaded_docs and not isinstance(loaded_docs[0], dict)):
                            logger.error("Invalid document structure in documents.json")
                            raise ValueError("Invalid document structure in documents.json")
                            
                        global_state.data_manager.documents = loaded_docs
                    
                    # Update state
                    global_state.system_status.data_loaded = True
                    doc_count = len(global_state.data_manager.documents)
                    global_state.indexing_status.documents_count = doc_count
                    
                    # Update indexed document IDs
                    global_state.data_manager.indexed_document_ids = set(doc["id"] for doc in global_state.data_manager.documents)
                    
                    logger.info(f"Loaded {doc_count} documents from file")
                    
                    # Make sure indexing_status is consistent with the loaded documents
                    if global_state.indexing_status.documents_count != doc_count:
                        logger.warning(f"Fixing inconsistent document count: {global_state.indexing_status.documents_count} -> {doc_count}")
                        global_state.indexing_status.documents_count = doc_count
                        
                except Exception as e:
                    logger.error(f"Error loading documents from file: {str(e)}")
                    logger.error(traceback.format_exc())
            
            # Initialize SearchEngine but don't fully load indexes yet
            global_state.search_engine = SearchEngine(global_state.data_manager, initialize_on_start=False)
            global_state.search_engine.documents = global_state.data_manager.documents
            
            # Check if we have valid docs and indexes before trying to load
            if (global_state.data_manager.documents and len(global_state.data_manager.documents) > 0 and
                chroma_collection_exists and bm25_exists):
                
                logger.info("Found valid documents and indexes, attempting to load")
                
                # Load existing ChromaDB collection without updating
                if not global_state.data_manager.chroma_initialized:
                    try:
                        collection = global_state.data_manager.chroma_client.get_collection(
                            name=COLLECTION_NAME,
                            embedding_function=global_state.data_manager.embedding_function
                        )
                        global_state.data_manager.collection = collection
                        global_state.data_manager.chroma_initialized = True
                        global_state.system_status.chroma_ready = True
                        global_state.search_engine.collection = collection
                        logger.info("Loaded existing ChromaDB collection")
                    except Exception as e:
                        logger.error(f"Error loading ChromaDB collection: {str(e)}")
                        logger.error(traceback.format_exc())
                
                # If BM25 exists, just load it
                if bm25_exists and global_state.search_engine:
                    try:
                        global_state.search_engine._load_bm25()
                        
                        # Verify that loaded corpus matches document count
                        if (global_state.search_engine.tokenized_corpus and 
                            len(global_state.search_engine.tokenized_corpus) != len(global_state.data_manager.documents)):
                            logger.warning(f"BM25 corpus size mismatch: {len(global_state.search_engine.tokenized_corpus)} vs {len(global_state.data_manager.documents)} documents")
                            logger.info("Will rebuild BM25 index after startup")
                        else:
                            global_state.search_engine.is_initialized = True
                            global_state.system_status.index_ready = True
                            logger.info("Loaded existing BM25 index")
                    except Exception as e:
                        logger.error(f"Error loading BM25 index: {str(e)}")
                        logger.error(traceback.format_exc())
                        
                # Validate the search engine state
                if global_state.search_engine:
                    valid = global_state.search_engine.validate_state()
                    if not valid:
                        logger.warning("Search engine validation failed")
                        # We'll fix it in the next startup phase
            
            logger.info("Loaded existing data")
            
            # Final verification of indexing_status consistency
            doc_count = len(global_state.data_manager.documents) if global_state.data_manager.documents else 0
            if global_state.indexing_status.documents_count != doc_count:
                logger.warning(f"Final fix for document count: {global_state.indexing_status.documents_count} -> {doc_count}")
                global_state.indexing_status.documents_count = doc_count
                
            global_state.save_state()
            
            # Check if we need to fix indexes
            if (not global_state.search_engine.is_initialized or 
                not global_state.search_engine.bm25_initialized or 
                not global_state.data_manager.chroma_initialized):
                
                logger.info("Search engine needs initialization after startup")
                
                # Initialize search engine after startup
                @app.on_event("startup")
                async def post_startup_init():
                    # Wait a short time to let the API start
                    time.sleep(2)
                    
                    logger.info("Post-startup initialization of search engine")
                    # Run indexing without forcing refresh but allow rebuild of indexes
                    run_indexing(force_update=False)
        else:
            # If we're missing documents, initialize without loading
            logger.info("Not all required data found for auto-loading")
            if not documents_exist:
                logger.info("Documents file not found")
            if not chroma_collection_exists:
                logger.info("ChromaDB collection not found")
            
            # Initialize SearchEngine without loading
            global_state.search_engine = SearchEngine(global_state.data_manager, initialize_on_start=False)
            logger.info("API ready but needs initialization before use")
        
        logger.info("RAGZ Document Search API startup completed")
        logger.info(f"Final documents_count in indexing_status: {global_state.indexing_status.documents_count}")
        
    except Exception as e:
        logger.error(f"Error during startup: {str(e)}")
        logger.error(traceback.format_exc())
        global_state.system_status.server_up = True  # Server läuft, aber mit Einschränkungen
        global_state.indexing_status.message = f"Error during startup: {str(e)}"
        global_state.save_state()
        
        # Even if there's an error, try to initialize basic components
        if not global_state.data_manager:
            try:
                global_state.data_manager = DataManager(initialize_on_start=False)
            except Exception as dm_error:
                logger.error(f"Failed to initialize DataManager: {str(dm_error)}")
        
        if not global_state.search_engine and global_state.data_manager:
            try:
                global_state.search_engine = SearchEngine(global_state.data_manager, initialize_on_start=False)
            except Exception as se_error:
                logger.error(f"Failed to initialize SearchEngine: {str(se_error)}")

@app.post("/search", response_model=List[SearchResult])
async def search_documents(request: SearchRequest, search_engine: SearchEngine = Depends(get_search_engine)):
    """Search documents with the given query and filters"""
    try:
        logger.info(f"Search request: {request}")
        return search_engine.search(request)
    except Exception as e:
        logger.error(f"Search error: {str(e)}")
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/context", response_model=dict)
async def get_context(request: AskQuestionRequest, search_engine: SearchEngine = Depends(get_search_engine)):
    """Get context for a question without answering it"""
    try:
        logger.info(f"Context request: {request.question}")
        
        # Validate search engine state before using
        if not search_engine.is_initialized or not search_engine.validate_state():
            logger.warning("Search engine validation failed, attempting to reinitialize")
            search_engine.initialize(force_update=False)
        
        # Search for relevant documents
        search_results = search_engine.search(SearchRequest(query=request.question))
        
        # Check if we got any results
        if not search_results or len(search_results) == 0:
            logger.warning("No search results found for context request")
            return {
                "context": "No relevant documents found.",
                "sources": [],
                "query": request.question
            }
        
        # Make sure we don't exceed the requested max sources
        max_sources = min(request.max_sources, len(search_results))
        
        # Prepare sources
        sources = []
        context = ""
        
        for i, result in enumerate(search_results[:max_sources]):
            # Validate the result before using
            if not hasattr(result, 'title') or not hasattr(result, 'snippet'):
                logger.error(f"Invalid search result at index {i}")
                continue
                
            context += f"Document {i+1}: {result.title}\n{result.snippet}\n\n"
            sources.append({
                "title": result.title,
                "correspondent": result.correspondent,
                "date": result.date,
                "snippet": result.snippet,
                "doc_id": result.doc_id
            })
        
        return {
            "context": context,
            "sources": sources,
            "query": request.question
        }
    except Exception as e:
        logger.error(f"Context error: {str(e)}")
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/status", response_model=dict)
async def get_status():
    """Get system status with accurate document count and additional fields"""
    # Sync indexing_status from global_state to system_status
    global_state.system_status.indexing_status = global_state.indexing_status
    
    # Ensure document count is accurate before returning status
    if global_state.data_manager and hasattr(global_state.data_manager, 'documents') and global_state.data_manager.documents:
        doc_count = len(global_state.data_manager.documents)
        if doc_count > 0 and global_state.indexing_status.documents_count != doc_count:
            logger.warning(f"Correcting document count discrepancy in status response: {global_state.indexing_status.documents_count} -> {doc_count}")
            global_state.indexing_status.documents_count = doc_count
            # Also update in system_status
            global_state.system_status.indexing_status.documents_count = doc_count
    elif global_state.indexing_status.documents_count > 0:
        # If we have a count in the state but no documents loaded, don't zero it out
        logger.info(f"Preserving document count in status response: {global_state.indexing_status.documents_count}")
        # Ensure system_status has the same value
        global_state.system_status.indexing_status.documents_count = global_state.indexing_status.documents_count
    
    # Log what we're about to return for debugging
    logger.info(f"Status API returning documents_count: {global_state.system_status.indexing_status.documents_count}")
    
    # Convert the status to a dict and add the AI model info
    status_dict = global_state.system_status.dict()
    status_dict["ai_status"] = "ok"
    status_dict["ai_model"] = os.environ.get("OLLAMA_MODEL", "llama3.2:latest")
    
    return status_dict

@app.get("/indexing/status", response_model=IndexingStatus)
async def get_indexing_status():
    """Get indexing status"""
    return global_state.indexing_status

@app.post("/indexing/check")
async def check_for_updates():
    """Check if updates are available"""
    if global_state.indexing_status.running:
        return {"status": "running", "message": "Indexing already in progress"}
    
    needs_update, message = global_state.data_manager.check_for_updates()
    return {"needs_update": needs_update, "message": message}

@app.post("/indexing/start")
async def start_indexing(request: IndexingRequest, background_tasks: BackgroundTasks):
    """Start indexing process"""
    if global_state.indexing_status.running:
        return {"status": "running", "message": "Indexing already in progress"}
    
    # Initialize models if not already done
    if not global_state.data_manager.is_initialized:
        global_state.data_manager.initialize_models()
    
    # Start indexing in background
    if request.background:
        background_tasks.add_task(run_indexing, request.force, False)
        return {"status": "started", "message": "Indexing started in background"}
    else:
        # Run indexing in foreground
        run_indexing(request.force, False)
        return {"status": "completed", "message": "Indexing completed"}

@app.post("/initialize")
async def initialize_system(force: bool = False, background: bool = True, background_tasks: BackgroundTasks = None):
    """Initialize the system and check environment variables"""
    env_vars = {
        "PAPERLESS_URL": os.getenv("PAPERLESS_URL"),
        "PAPERLESS_NGX_URL": os.getenv("PAPERLESS_NGX_URL"),
        "PAPERLESS_HOST": os.getenv("PAPERLESS_HOST"),
        "PAPERLESS_TOKEN": "[HIDDEN]" if os.getenv("PAPERLESS_TOKEN") else None,
        "PAPERLESS_API_TOKEN": "[HIDDEN]" if os.getenv("PAPERLESS_API_TOKEN") else None,
        "PAPERLESS_APIKEY": "[HIDDEN]" if os.getenv("PAPERLESS_APIKEY") else None
    }
    
    env_file_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', '.env')
    env_file_exists = os.path.exists(env_file_path)
    
    # Check if indexing is already running
    if global_state.indexing_status.running:
        return {
            "status": "running", 
            "message": "Indexing already in progress",
            "env_file_exists": env_file_exists,
            "env_file_path": env_file_path if env_file_exists else None,
            "environment_variables": env_vars,
            "working_directory": os.getcwd(),
            "config_valid": bool(global_state.data_manager and global_state.data_manager.paperless_url and global_state.data_manager.paperless_token)
        }
    
    # Initialize data manager if needed
    if not global_state.data_manager.is_initialized:
        global_state.data_manager.initialize_models()
    
    # Load documents if needed
    if not global_state.system_status.data_loaded or force:
        global_state.data_manager.load_documents(force_refresh=force, check_new=False)
    
    # Initialize search engine
    if background and background_tasks:
        background_tasks.add_task(run_indexing, force, False)
        status = "initializing"
        message = "System initialization started in background"
    else:
        run_indexing(force, False)
        status = "initialized"
        message = "System initialized"
    
    return {
        "status": status, 
        "message": message,
        "data_loaded": global_state.system_status.data_loaded,
        "index_ready": global_state.system_status.index_ready,
        "env_file_exists": env_file_exists,
        "env_file_path": env_file_path if env_file_exists else None,
        "environment_variables": env_vars,
        "working_directory": os.getcwd(),
        "config_valid": bool(global_state.data_manager and global_state.data_manager.paperless_url and global_state.data_manager.paperless_token)
    }

@app.post("/check_health")
async def check_health():
    """Perform a comprehensive health check of the system"""
    health_status = {
        "server_status": "ok",
        "data_manager": "unknown",
        "search_engine": "unknown",
        "documents_loaded": False,
        "chroma_initialized": False,
        "bm25_initialized": False,
        "issues": [],
        "recommendations": []
    }
    
    try:
        # Check data manager
        if not global_state.data_manager:
            health_status["issues"].append("DataManager not initialized")
            health_status["recommendations"].append("Call /initialize endpoint")
            health_status["data_manager"] = "missing"
        elif not global_state.data_manager.is_initialized:
            health_status["issues"].append("DataManager models not initialized")
            health_status["recommendations"].append("Call /initialize endpoint")
            health_status["data_manager"] = "uninitialized"
        else:
            health_status["data_manager"] = "ok"
            
        # Check documents
        if global_state.data_manager and global_state.data_manager.documents:
            doc_count = len(global_state.data_manager.documents)
            health_status["documents_loaded"] = True
            health_status["document_count"] = doc_count
            
            if doc_count == 0:
                health_status["issues"].append("No documents loaded")
                health_status["recommendations"].append("Check Paperless API configuration and call /indexing/start with force=true")
        else:
            health_status["issues"].append("Documents not loaded")
            health_status["recommendations"].append("Call /initialize endpoint")
            
        # Check search engine
        if not global_state.search_engine:
            health_status["issues"].append("SearchEngine not initialized")
            health_status["recommendations"].append("Call /initialize endpoint")
            health_status["search_engine"] = "missing"
        elif not global_state.search_engine.is_initialized:
            health_status["issues"].append("SearchEngine not fully initialized")
            health_status["recommendations"].append("Call /initialize endpoint")
            health_status["search_engine"] = "uninitialized"
        else:
            # Validate search engine components
            health_status["search_engine"] = "ok"
            
            # Check ChromaDB
            if global_state.search_engine.collection:
                health_status["chroma_initialized"] = True
                try:
                    collection_count = global_state.search_engine.collection.count()
                    health_status["chroma_document_count"] = collection_count
                    
                    if collection_count == 0:
                        health_status["issues"].append("ChromaDB collection is empty")
                        health_status["recommendations"].append("Call /indexing/start with force=true")
                except Exception as e:
                    health_status["issues"].append(f"ChromaDB error: {str(e)}")
                    health_status["recommendations"].append("Call /indexing/start with force=true to rebuild ChromaDB")
            else:
                health_status["issues"].append("ChromaDB collection not initialized")
                health_status["recommendations"].append("Call /indexing/start endpoint")
                
            # Check BM25
            if global_state.search_engine.bm25 and global_state.search_engine.tokenized_corpus:
                health_status["bm25_initialized"] = True
                
                bm25_count = len(global_state.search_engine.tokenized_corpus)
                health_status["bm25_document_count"] = bm25_count
                
                # Check for document count mismatch
                if health_status["documents_loaded"] and bm25_count != health_status["document_count"]:
                    health_status["issues"].append(f"BM25 document count mismatch: {bm25_count} vs {health_status['document_count']}")
                    health_status["recommendations"].append("Call /indexing/start with force=true to rebuild BM25")
            else:
                health_status["issues"].append("BM25 index not initialized")
                health_status["recommendations"].append("Call /indexing/start endpoint")
                
        # Final health assessment
        if not health_status["issues"]:
            health_status["overall_status"] = "healthy"
        elif len(health_status["issues"]) <= 2:
            health_status["overall_status"] = "warning"
        else:
            health_status["overall_status"] = "critical"
            
    except Exception as e:
        health_status["server_status"] = "error"
        health_status["error"] = str(e)
        health_status["overall_status"] = "critical"
        health_status["issues"].append(f"Error during health check: {str(e)}")
        health_status["recommendations"].append("Restart the server and call /initialize with force=true")
        
    return health_status

# Main entry point with configuration options
if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="RAGZ Document Search API")
    parser.add_argument("--port", type=int, default=8000, help="Port to run the server on")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host to run the server on")
    parser.add_argument("--initialize", action="store_true", help="Initialize search engine on startup if needed")
    parser.add_argument("--force-refresh", action="store_true", help="Force refresh documents from API")
    parser.add_argument("--auto-load", action="store_true", default=True, help="Automatically load existing index if available")
    parser.add_argument("--check-new", action="store_true", help="Check for new documents on startup")
    parser.add_argument("--skip-check", action="store_true", help="Skip checking for new documents even with --initialize")
    parser.add_argument("--rebuild-indexes", action="store_true", help="Force rebuild of BM25 and ChromaDB indexes on startup")
    
    args = parser.parse_args()
    
    # If initialization is requested from command line, set this for startup
    if args.initialize:
        logger.info("Auto-initialization requested via command line")
        if args.skip_check:
            logger.info("Will skip checking for new documents during initialization")
        
        @app.on_event("startup")
        async def initialize_on_startup():
            logger.info("Running initialization after startup")
            # Give the app time to start
            time.sleep(1)
            
            # Check if we already have documents loaded
            if global_state.system_status.data_loaded and not args.force_refresh:
                logger.info(f"Already have {global_state.indexing_status.documents_count} documents loaded")
                
                # If explicitly told to skip checking, don't run indexing
                if args.skip_check and not args.rebuild_indexes:
                    logger.info("Skipping document check due to --skip-check flag")
                    
                    # Just make sure search engine is initialized with existing data
                    if not global_state.system_status.index_ready:
                        logger.info("Initializing search engine with existing data")
                        global_state.search_engine.initialize(force_update=args.rebuild_indexes)
                    
                    return
            
            # Only run indexing if we need to
            run_indexing(args.force_refresh, args.check_new)
    
    # If check-new is requested from command line
    elif args.check_new:
        logger.info("Check for new documents requested via command line")
        
        @app.on_event("startup")
        async def check_new_on_startup():
            logger.info("Checking for new documents after startup")
            # Give the app time to start
            time.sleep(1)
            # Run indexing with check_new=True but without force refresh
            run_indexing(False, True)
    
    # If rebuild-indexes is requested from command line
    elif args.rebuild_indexes:
        logger.info("Rebuild indexes requested via command line")
        
        @app.on_event("startup")
        async def rebuild_indexes_on_startup():
            logger.info("Rebuilding indexes after startup")
            # Give the app time to start
            time.sleep(2)
            
            if global_state.search_engine and global_state.data_manager.documents:
                logger.info("Rebuilding indexes with existing documents")
                global_state.search_engine.initialize(force_update=True)
    
    uvicorn.run("main:app", host=args.host, port=args.port, reload=False)