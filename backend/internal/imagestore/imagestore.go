// Package imagestore keeps item photos in an S3-compatible object store
// (SeaweedFS in compose and Kubernetes; the minio-go client speaks plain S3,
// so MinIO, AWS S3 or any other S3 store works with only env changes).
// api-server runs as 2-6 replicas that the
// HPA creates and deletes, so a photo can't live on any one replica's disk:
// every replica writes to the same bucket, and nginx serves the bucket's
// objects to browsers directly under /images/.
package imagestore

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync/atomic"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// PublicPrefix is where nginx serves the bucket; stored image URLs start with it.
const PublicPrefix = "/images/"

// MaxBytes is the largest photo accepted. Phone photos are usually 2-5 MB.
const MaxBytes = 8 << 20

// ErrUnsupportedType means the bytes aren't a JPEG, PNG, WebP or GIF,
// whatever the file name or Content-Type header claimed.
var ErrUnsupportedType = errors.New("unsupported image type")

// ErrNotReady means the bucket hasn't been set up yet (the store is still starting).
var ErrNotReady = errors.New("image store not ready")

var extByType = map[string]string{
	"image/jpeg": ".jpg",
	"image/png":  ".png",
	"image/webp": ".webp",
	"image/gif":  ".gif",
}

type Store struct {
	client *minio.Client
	bucket string
	ready  atomic.Bool
}

func New(endpoint, accessKey, secretKey, bucket string) (*Store, error) {
	c, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: false, // in-cluster traffic only; browsers reach it through nginx
	})
	if err != nil {
		return nil, err
	}
	return &Store{client: c, bucket: bucket}, nil
}

// EnsureBucket creates the bucket if needed and lets anyone read (not list or
// write) its objects, so nginx can proxy GETs without signing them. Safe to
// call from every replica at once.
func (s *Store) EnsureBucket(ctx context.Context) error {
	exists, err := s.client.BucketExists(ctx, s.bucket)
	if err != nil {
		return err
	}
	if !exists {
		if err := s.client.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{}); err != nil {
			// another replica may have created it a moment ago
			if again, err2 := s.client.BucketExists(ctx, s.bucket); err2 != nil || !again {
				return err
			}
		}
	}
	// Stores that grant anonymous reads in their own config instead (SeaweedFS
	// here: deploy/seaweedfs/s3.json) may not implement bucket policies, so a
	// failure is only logged; nginx's GETs then show whether reads work.
	policy := fmt.Sprintf(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":["*"]},"Action":["s3:GetObject"],"Resource":["arn:aws:s3:::%s/*"]}]}`, s.bucket)
	if err := s.client.SetBucketPolicy(ctx, s.bucket, policy); err != nil {
		log.Printf("images: bucket policy not set (%v); relying on the store's own anonymous-read config", err)
	}
	s.ready.Store(true)
	return nil
}

// DetectType returns the image MIME type from the file's first bytes, or ""
// if it isn't one of the accepted formats.
func DetectType(data []byte) string {
	ct := http.DetectContentType(data)
	if _, ok := extByType[ct]; ok {
		return ct
	}
	return ""
}

// Put stores one photo under a random name and returns its public URL path.
func (s *Store) Put(ctx context.Context, data []byte) (string, error) {
	if !s.ready.Load() {
		return "", ErrNotReady
	}
	ct := DetectType(data)
	if ct == "" {
		return "", ErrUnsupportedType
	}
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	key := "items/" + hex.EncodeToString(b[:]) + extByType[ct]
	_, err := s.client.PutObject(ctx, s.bucket, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{
		ContentType: ct,
		// names are random and never reused, so browsers may cache forever
		CacheControl: "public, max-age=31536000, immutable",
	})
	if err != nil {
		return "", err
	}
	return PublicPrefix + key, nil
}
